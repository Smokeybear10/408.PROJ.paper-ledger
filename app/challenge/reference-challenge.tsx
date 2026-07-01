"use client";

import { useEffect, useRef, useState } from "react";
import { investigationResponseSchema, type InvestigationRequest, type InvestigationResponse } from "../../lib/contracts";
import { buildReferenceChallenge, REFERENCE_SCENARIOS } from "../../lib/reference-scenarios";
import { formatMoney } from "../../lib/reconciliation";
import { validateProposalEvidence } from "../../lib/proposal-evidence";
import CompetingEvidence from "../competing-evidence";

type Props = { provider: "codex" | "gemini" | null };
type Result = { request: InvestigationRequest; response: InvestigationResponse; elapsedMs: number };

function requestError(value: unknown): string {
  if (value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "message" in value.error && typeof value.error.message === "string") return value.error.message;
  return "The investigation could not complete. Your test note is still here.";
}

export default function ReferenceChallenge({ provider }: Props) {
  const [scenarioId, setScenarioId] = useState(REFERENCE_SCENARIOS[0].id);
  const scenario = REFERENCE_SCENARIOS.find((item) => item.id === scenarioId) ?? REFERENCE_SCENARIOS[0];
  const [note, setNote] = useState(scenario.notes[0].text);
  const [approvedProvider, setApprovedProvider] = useState<Props["provider"]>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const activeRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  const approved = provider !== null && approvedProvider === provider;
  const providerName = provider === "codex" ? "OpenAI via Codex" : "Google Gemini";
  const preset = scenario.notes.find((item) => item.text.trim() === note.trim());

  useEffect(() => () => activeRequest.current?.controller.abort(), []);
  useEffect(() => { clearResult(); }, [provider]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  function clearResult() {
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
    setBusy(false);
    setResult(null);
    setApprovedProvider(null);
    setError("");
    setElapsedSeconds(0);
  }

  function chooseScenario(id: string) {
    const next = REFERENCE_SCENARIOS.find((item) => item.id === id);
    if (!next) return;
    clearResult();
    setScenarioId(next.id);
    setNote(next.notes[0].text);
  }

  function editNote(text: string) {
    clearResult();
    setNote(text);
  }

  async function investigate() {
    if (!provider || !approved || !note.trim() || activeRequest.current) return;
    const request = buildReferenceChallenge(scenario, note, crypto.randomUUID());
    const controller = new AbortController();
    activeRequest.current = { id: request.requestId, controller };
    setBusy(true);
    setResult(null);
    setError("");
    setElapsedSeconds(0);
    const started = performance.now();
    try {
      const response = await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, expectedProvider: provider, includeCandidateAssessments: true }), signal: controller.signal });
      const body: unknown = await response.json();
      if (activeRequest.current?.id !== request.requestId) return;
      if (!response.ok) throw new Error(requestError(body));
      const parsed = investigationResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.requestId !== request.requestId || parsed.data.fingerprint !== request.fingerprint || parsed.data.provider !== provider || !validateProposalEvidence(parsed.data.proposal, request, { requireAssessments: true })) throw new Error("The response did not pass evidence checks. No interpretation has been applied.");
      setResult({ request, response: parsed.data, elapsedMs: Math.round(performance.now() - started) });
      requestAnimationFrame(() => { resultRef.current?.scrollIntoView({ block: "start" }); resultRef.current?.focus({ preventScroll: true }); });
    } catch (failure) {
      if (activeRequest.current?.id === request.requestId && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The investigation could not complete.");
    } finally {
      if (activeRequest.current?.id === request.requestId) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  const verdict = result?.response.proposal;
  const expectedMatches = result && preset ? verdict?.category === preset.expected && verdict.invoiceId === preset.invoiceId : null;

  return <div className="challenge-app">
    <header className="challenge-header"><a className="brand" href="/">Paper Ledger</a><span>Reference challenge</span><a className="challenge-back" href="/">Open workspace ↗</a></header>
    <main className="challenge-shell">
      <div className="challenge-intro"><p className="eyebrow">SYNTHETIC CASES · REAL MODEL REQUESTS</p><h1>Make the evidence change its mind.</h1><p>Correct a note, create a conflict, or remove the detail that identifies an invoice. Inspect what the model supports, contradicts and leaves unknown.</p><span className="challenge-source-note">Fictional business records. No PayPal request, ledger allocation or money movement.</span></div>
      <div className="challenge-layout">
        <aside className="challenge-scenarios" aria-label="Reference challenge cases"><h2>Choose a case</h2>{REFERENCE_SCENARIOS.map((item, index) => <button key={item.id} className={scenario.id === item.id ? "challenge-case active" : "challenge-case"} aria-pressed={scenario.id === item.id} onClick={() => chooseScenario(item.id)}><span className="challenge-case-number">0{index + 1}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span aria-hidden="true">↗</span></button>)}<p>Expected answers are checked locally after a response. They are never included in the model request.</p></aside>
        <div className="challenge-work">
          <section className="challenge-records" aria-labelledby="challenge-record-title"><div className="challenge-section-heading"><div><p className="eyebrow">ONE RECEIPT · TWO INVOICES</p><h2 id="challenge-record-title">{scenario.title}</h2></div><span className="challenge-synthetic">Synthetic</span></div>
            <div className="challenge-payment"><span>{scenario.paymentId}<small>Completed · same anonymous customer</small></span><dl><div><dt>Gross</dt><dd>{formatMoney(scenario.amountMinor)}</dd></div><div><dt>Fee</dt><dd>{formatMoney(scenario.feeMinor)}</dd></div><div><dt>Net</dt><dd>{formatMoney(scenario.amountMinor - scenario.feeMinor)}</dd></div></dl></div>
            <p className={scenario.invoiceReference ? "challenge-reference has-reference" : "challenge-reference"}>Structured invoice reference <strong>{scenario.invoiceReference ?? "Not supplied"}</strong></p>
            <div className="challenge-invoices">{scenario.invoices.map((invoice) => <article key={invoice.id}><span>{invoice.id}</span><h3>{invoice.description}</h3><p><strong>{formatMoney(scenario.amountMinor)}</strong><span>Due {invoice.dueDate}</span></p></article>)}</div>
          </section>
          <section className="challenge-editor" aria-labelledby="challenge-note-title"><div className="challenge-section-heading"><div><p className="eyebrow">EDIT THE EVIDENCE</p><h2 id="challenge-note-title">Payment note</h2></div><span>{note.length} / 1,200</span></div>
            <div className="challenge-presets" aria-label="Test note variants">{scenario.notes.map((variant) => <button key={variant.label} className={variant.text === note ? "active" : ""} aria-pressed={variant.text === note} onClick={() => editNote(variant.text)}>{variant.label}</button>)}</div>
            <label className="sr-only" htmlFor="challenge-note">Synthetic payment note</label><textarea id="challenge-note" value={note} onChange={(event) => editNote(event.target.value)} maxLength={1200} rows={5} spellCheck={false} /><p className="challenge-edit-note">Editing clears the previous interpretation and its approval. Invoice amounts and source references stay fixed.</p>
            <details className="challenge-packet"><summary>Review the exact evidence packet</summary><p>The note above, both invoice descriptions, amounts, dates, statuses, source IDs and one anonymous customer group go to {provider ? providerName : "the configured AI provider"}. No names, emails, expected answers or other workspace records are included.</p><pre>{JSON.stringify(buildReferenceChallenge(scenario, note.trim() ? note : "[empty note; sending disabled]", "assigned-on-send"), (key, value: unknown) => ["fingerprint", "requestId"].includes(key) ? undefined : value, 2)}</pre></details>
            {provider ? <label className="consent-label"><input type="checkbox" checked={approved} onChange={(event) => { if (event.target.checked) setApprovedProvider(provider); else clearResult(); }} /><span>I reviewed this synthetic note and both invoice descriptions for sending to {providerName}.</span></label> : <p className="configuration-note">Live AI is not configured. You can inspect and edit the cases; configure the server's AI provider to run them.</p>}
            <div className="challenge-run"><button className="primary" onClick={investigate} disabled={!provider || !approved || !note.trim() || busy}>{busy ? `Investigating · ${elapsedSeconds}s` : result ? "Run another investigation" : "Investigate this note"}</button>{busy && <button onClick={() => { clearResult(); setError("Investigation cancelled. No interpretation was applied."); }}>Cancel investigation</button>}<span>{provider ? `Live ${provider === "codex" ? "Codex" : "Gemini"} request · no prerecorded response` : "No request will be sent"}</span></div>
            {error && <p className="inline-error" role="alert">{error}</p>}
          </section>
          {result && <section className="challenge-result" aria-label="Challenge result" tabIndex={-1} ref={resultRef}><div className="challenge-result-heading"><div><p className="eyebrow">RETURNED MODEL INTERPRETATION</p><h2>{verdict?.category === "reference_interpretation" ? `Suggests ${verdict.invoiceId}` : scenario.invoiceReference ? "Hold for reference review" : "No supported allocation"}</h2></div><span>{(result.elapsedMs / 1000).toFixed(1)}s · {result.response.provider === "codex" ? "Codex" : "Gemini"}</span></div><p className="challenge-result-note">{verdict?.category === "reference_interpretation" ? "A cited suggestion for human review. Nothing has been confirmed or allocated." : "The model did not select an invoice. Keep the payment unallocated while the evidence is unresolved."}</p><CompetingEvidence response={result.response} context={result.request} historical={false} />{preset ? <p className={`challenge-expectation${expectedMatches ? " matched" : ""}`}><strong>{expectedMatches ? "Matches this preset's expected outcome." : "Does not match this preset's expected outcome."}</strong> Expected: {preset.invoiceId ? `a suggestion for ${preset.invoiceId}` : preset.expected === "ambiguous" ? "ambiguous evidence with no invoice selected" : "no supported match with no invoice selected"}. This is one synthetic functional check, not an accuracy benchmark.</p> : <p className="challenge-expectation">Custom note: no predeclared answer. Check the literal quotes and interpretation yourself.</p>}<p className="challenge-result-meta">{result.response.model} · {new Date(result.response.generatedAt).toLocaleString()} · request {result.response.requestId}</p></section>}
        </div>
      </div>
    </main>
  </div>;
}
