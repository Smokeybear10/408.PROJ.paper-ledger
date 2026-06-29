import { z } from "zod";
import type { ApiError } from "@/lib/contracts";

const MAX_BODY_BYTES = 128 * 1024;
const localHosts = new Set(["127.0.0.1:3107", "localhost:3107"]);

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function readJsonBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, upstream = false): Promise<unknown> {
  const invalid = () => new ApiFailure(upstream ? 502 : 400, upstream ? "invalid_provider_response" : "invalid_json", upstream ? "The provider returned an invalid response. Try again." : "Send a valid JSON request.");
  if (!body) throw invalid();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiFailure(upstream ? 502 : 413, upstream ? "provider_response_too_large" : "request_too_large", upstream ? "The provider response exceeded the supported size. Reduce the request." : "The request exceeds the 128 KB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid();
  }
}

export async function readLocalRequest<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const host = request.headers.get("host");
  if (!host || !localHosts.has(host) || request.headers.get("origin") !== `http://${host}`) {
    throw new ApiFailure(403, "local_request_required", "Use this app from its local address on port 3107.");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiFailure(415, "json_required", "Use application/json for this request.");
  }
  const declaredSize = request.headers.get("content-length");
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_BODY_BYTES)) {
    throw new ApiFailure(413, "request_too_large", "The request exceeds the 128 KB limit.");
  }
  const parsed = schema.safeParse(await readJsonBody(request.body, MAX_BODY_BYTES));
  if (!parsed.success) throw new ApiFailure(400, "invalid_request", "The request does not match the supported format.");
  return parsed.data;
}

export function apiJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function apiError(error: unknown): Response {
  const failure = error instanceof ApiFailure ? error : new ApiFailure(500, "internal_error", "The request could not be completed. Try again.");
  const body: ApiError = { error: { code: failure.code, message: failure.message } };
  return apiJson(body, failure.status);
}

export async function fetchProviderJson(url: URL | string, options: RequestInit, timeoutMs: number, maxBytes = 4 * 1024 * 1024): Promise<{ status: number; data: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetch(url, { ...options, signal, redirect: "error", cache: "no-store" });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, data: null };
    }
    return { status: response.status, data: await readJsonBody(response.body, maxBytes, true) };
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    if (timeout.aborted) throw new ApiFailure(504, "provider_timeout", "The provider timed out. Your current data has not been replaced.");
    if (options.signal?.aborted) throw new ApiFailure(499, "request_cancelled", "The request was cancelled.");
    throw new ApiFailure(502, "provider_unavailable", "The provider could not be reached. Your current data has not been replaced.");
  }
}
