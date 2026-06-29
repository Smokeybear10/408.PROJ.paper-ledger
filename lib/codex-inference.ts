import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ApiFailure } from "./server-boundary";

const binarySchema = z.string().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value) && (value === "codex" || isAbsolute(value)));
const modelSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/);
const disabledFeatures = ["apps", "browser_use", "computer_use", "shell_tool", "unified_exec", "view_image", "image_generation", "code_mode_host", "skill_search", "hooks", "workspace_dependencies", "multi_agent", "goals", "sleep_tool"];
const allowedEvents = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"]);
const eventSchema = z.object({ type: z.string(), item: z.object({ type: z.string(), message: z.string().optional() }).passthrough().optional() }).passthrough();
const MAX_OUTPUT_BYTES = 512 * 1024;
const TIMEOUT_MS = 60_000;
let busy = false;

export async function runCodexInference(input: { prompt: string; schema: unknown; signal: AbortSignal }): Promise<{ value: unknown; model: string }> {
  const binary = binarySchema.safeParse(process.env.CODEX_BIN?.trim() || "codex");
  const configuredModel = process.env.CODEX_MODEL?.trim();
  if (!binary.success || (configuredModel && !modelSchema.safeParse(configuredModel).success)) throw new ApiFailure(503, "invalid_codex_configuration", "Set CODEX_BIN to the Codex executable and CODEX_MODEL to a supported model ID, then restart.");
  if (busy) throw new ApiFailure(429, "investigation_in_progress", "Another local model investigation is running. Wait for it or cancel it before starting another.");
  if (input.signal.aborted) throw new ApiFailure(499, "request_cancelled", "The investigation was cancelled.");
  busy = true;
  let directory: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "paper-ledger-investigation-"));
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "result.json");
    await writeFile(schemaPath, JSON.stringify(input.schema), { mode: 0o600 });
    const args = ["--no-daemon", "-a", "never", "exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--json", "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", directory, "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"'];
    for (const feature of disabledFeatures) args.push("--disable", feature);
    args.push("--enable", "skip_host_skill_discovery");
    if (configuredModel) args.push("--model", configuredModel);
    args.push("-");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV || "production", ...Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "CODEX_HOME"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])) };
    const timeout = new AbortController();
    timer = setTimeout(() => { timedOut = true; timeout.abort(); }, TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary.data, args, { cwd: directory, env: environment, stdio: ["pipe", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
      let bytes = 0;
      let overflow = false;
      let startupFailure: ApiFailure | null = null;
      const receive = (chunk: Buffer, retain: boolean) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_OUTPUT_BYTES) { overflow = true; child.kill("SIGKILL"); return; }
        if (retain) chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => receive(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => receive(chunk, false));
      child.once("error", () => { startupFailure = new ApiFailure(timedOut ? 504 : input.signal.aborted ? 499 : 502, timedOut ? "codex_timeout" : input.signal.aborted ? "request_cancelled" : "codex_unavailable", timedOut ? "The local model timed out. Your evidence and decisions were kept." : input.signal.aborted ? "The investigation was cancelled." : "Codex could not start. Check CODEX_BIN and sign in with codex login."); });
      child.once("close", (code) => {
        if (startupFailure) reject(startupFailure);
        else if (overflow) reject(new ApiFailure(502, "codex_response_too_large", "The local model output exceeded the supported size. Your case remains unreviewed."));
        else if (signal.aborted) reject(new ApiFailure(timedOut ? 504 : 499, timedOut ? "codex_timeout" : "request_cancelled", timedOut ? "The local model timed out. Your case remains unreviewed." : "The investigation was cancelled."));
        else if (code !== 0) reject(new ApiFailure(502, "codex_request_failed", "Codex could not complete the investigation. Check local sign-in, model access and usage limits."));
        else resolve();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input.prompt);
    });
    for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean)) {
      const event = eventSchema.safeParse(JSON.parse(line) as unknown);
      if (!event.success || !allowedEvents.has(event.data.type)) throw new ApiFailure(502, "unsupported_codex_response", "The investigation returned an unsupported event. No proposal was applied.");
      const item = event.data.item;
      const disabledCapabilityWarning = item?.type === "error" && ["Under-development features enabled: skip_host_skill_discovery.", "Code Mode is unavailable because code-mode host is disabled."].some((message) => item.message?.startsWith(message));
      if (item && !["agent_message", "reasoning"].includes(item.type) && !disabledCapabilityWarning) throw new ApiFailure(502, "unsupported_codex_response", "The investigation returned an unsupported event. No proposal was applied.");
    }
    if ((await stat(outputPath)).size > 32768) throw new ApiFailure(502, "codex_response_too_large", "The local model response exceeded the supported size.");
    const value: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    return { value, model: configuredModel || "codex-cli-default" };
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(502, "invalid_codex_response", "The local model did not return a supported structured response. Your case remains unreviewed.");
  } finally {
    if (timer) clearTimeout(timer);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    busy = false;
  }
}
