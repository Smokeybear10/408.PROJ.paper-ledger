import { z } from "zod";
import { MAX_ROWS, idSchema, investigationContextSchema, investigationRequestSchema, investigationResponseSchema, type Dataset, type DecisionEvidence, type InvestigationRequest, type InvestigationResponse, type Invoice, type Payment, type ReviewState, type SourceInfo } from "./contracts";
import { buildInvestigationRequest, buildObservations, formatMoney, isEligibleReceipt, reconcile } from "./reconciliation";
import { buildExceptionDesk } from "./case-intelligence";
import { validateProposalEvidence } from "./proposal-evidence";
import { findReceiptCombinations } from "./receipt-combinations";

type Investigation = { response: InvestigationResponse; excerpt: string; excerptPaymentId: string; invoiceContexts?: Record<string, string>; invoiceScopeIds?: string[] };
type CaptureInput = { dataset: Dataset; before: ReviewState; after: ReviewState; invoiceId: string; paymentIds: string[]; action: "confirm" | "reject"; investigation: InvestigationResponse | null; excerpt: string; excerptPaymentId: string | null; invoiceContexts?: Record<string, string>; invoiceScopeIds?: string[] };
type BriefInput = { dataset: Dataset; review: ReviewState; invoiceId: string; draftPaymentIds?: string[]; decisionEvidence?: DecisionEvidence[]; investigation?: Investigation | null; generatedAt?: string };
type ValidatedInvestigation = { response: InvestigationResponse; context: InvestigationRequest; datasetRevision: number; reviewRevision: number };
type Decision = { invoiceId: string; paymentId: string; action: "confirm" | "reject"; datasetRevision: number; reviewRevision: number; at: string; reason: string };

const pairSchema = z.object({ invoiceId: idSchema, paymentId: idSchema }).strict();
const recordedContextSchema = investigationContextSchema.extend({
  datasetRevision: z.number().int().nonnegative(),
  reviewRevision: z.number().int().nonnegative(),
  allocations: z.array(pairSchema).max(MAX_ROWS),
  rejections: z.array(pairSchema).max(MAX_ROWS),
}).strict();

const unique = (values: string[]) => new Set(values).size === values.length;
const decisionKey = (decision: Pick<Decision, "action" | "invoiceId" | "paymentId">) => JSON.stringify([decision.action, decision.invoiceId, decision.paymentId]);

function decisions(review: ReviewState): Decision[] {
  return [
    ...review.allocations.map((decision) => ({ ...decision, action: "confirm" as const, at: decision.confirmedAt })),
    ...review.rejections.map((decision) => ({ ...decision, action: "reject" as const, at: decision.rejectedAt })),
  ];
}

function validProposal(response: InvestigationResponse, context: InvestigationRequest): boolean {
  return JSON.stringify(response.observations) === JSON.stringify(buildObservations(context))
    && validateProposalEvidence(response.proposal, context);
}

function currentInvestigation(dataset: Dataset, review: ReviewState, invoiceId: string, investigation: Investigation | null | undefined): ValidatedInvestigation | null {
  if (!investigation) return null;
  try {
    const parsed = investigationResponseSchema.safeParse(investigation.response);
    if (!parsed.success) return null;
    const context = buildInvestigationRequest(dataset, review, invoiceId, investigation.excerpt, parsed.data.requestId, investigation.excerptPaymentId, investigation.invoiceContexts, investigation.invoiceScopeIds);
    if (parsed.data.fingerprint !== context.fingerprint || !validProposal(parsed.data, context)) return null;
    return { response: parsed.data, context, datasetRevision: dataset.revision, reviewRevision: review.revision };
  } catch {
    return null;
  }
}

function recordedInvestigation(evidence: DecisionEvidence, dataset: Dataset): ValidatedInvestigation | null {
  try {
    const response = investigationResponseSchema.safeParse(evidence.investigation);
    if (!response.success || response.data.fingerprint.length > 32768) return null;
    const parsed = recordedContextSchema.safeParse(JSON.parse(response.data.fingerprint) as unknown);
    if (!parsed.success) return null;
    const context = parsed.data;
    if (context.datasetRevision !== dataset.revision || context.datasetRevision !== evidence.datasetRevision || context.reviewRevision >= evidence.reviewRevision || context.caseId !== evidence.invoiceId || context.excerptPaymentId !== evidence.paymentId || evidence.excerptPaymentId !== evidence.paymentId || context.excerpt !== evidence.excerpt.trim()) return null;
    const invoices = new Map(dataset.invoices.map((invoice) => [invoice.id, invoice]));
    const payments = new Map(dataset.payments.map((payment) => [payment.id, payment]));
    const invoiceContexts = z.record(z.string().min(1).max(100), z.string().max(500)).safeParse(evidence.invoiceContexts ?? {});
    if (!invoiceContexts.success || Object.entries(invoiceContexts.data).some(([id, value]) => !value.trim() || !context.invoices.some((invoice) => invoice.id === id && invoice.context === value))) return null;
    if (context.invoiceScope && context.invoiceScope.totalCandidates > dataset.invoices.length) return null;
    if (evidence.invoiceScopeIds !== undefined && (!context.invoiceScope || evidence.invoiceScopeIds.length !== context.invoices.length || !unique(evidence.invoiceScopeIds) || evidence.invoiceScopeIds.some((id) => !context.invoices.some((invoice) => invoice.id === id)))) return null;
    if (context.invoices.some((invoice) => {
      const original = invoices.get(invoice.id);
      const approved = Object.hasOwn(invoiceContexts.data, invoice.id) ? invoiceContexts.data[invoice.id] : "";
      return !original || invoice.amountMinor !== original.amountMinor || invoice.currency !== original.currency || invoice.dueDate !== original.dueDate || invoice.context !== approved;
    })) return null;
    if (context.payments.some((payment) => {
      const original = payments.get(payment.id);
      return !original || payment.grossMinor !== original.grossMinor || payment.feeMinor !== original.feeMinor || payment.netMinor !== original.netMinor || payment.currency !== original.currency || payment.invoiceId !== original.invoiceId || payment.status !== original.status || payment.kind !== original.kind || payment.eventCode !== original.eventCode;
    })) return null;
    const request = investigationRequestSchema.parse({ caseId: context.caseId, invoices: context.invoices, payments: context.payments, excerpt: context.excerpt, excerptPaymentId: context.excerptPaymentId, ...(context.invoiceScope ? { invoiceScope: context.invoiceScope } : {}), requestId: response.data.requestId, fingerprint: response.data.fingerprint });
    if (!validProposal(response.data, request)) return null;
    return { response: response.data, context: request, datasetRevision: context.datasetRevision, reviewRevision: context.reviewRevision };
  } catch {
    return null;
  }
}

export function retainedInvestigationContext(evidence: DecisionEvidence, dataset: Dataset): InvestigationRequest | null {
  return recordedInvestigation(evidence, dataset)?.context ?? null;
}

export function retainedInvestigationScope(evidence: DecisionEvidence, dataset: Dataset) {
  const context = retainedInvestigationContext(evidence, dataset);
  if (!context) return null;
  const included = context.invoices.length;
  return {
    included,
    total: context.invoiceScope?.totalCandidates ?? included,
    excluded: context.invoiceScope?.excludedCandidates ?? 0,
    payments: context.payments.length,
  };
}

export function captureDecisionEvidence(input: CaptureInput): DecisionEvidence[] {
  const { dataset, before, after, invoiceId, paymentIds, action, investigation, excerpt, excerptPaymentId, invoiceContexts, invoiceScopeIds } = input;
  if (!investigation || !excerptPaymentId || !paymentIds.includes(excerptPaymentId) || after.revision <= before.revision) return [];
  const analysis = currentInvestigation(dataset, before, invoiceId, { response: investigation, excerpt, excerptPaymentId, invoiceContexts, invoiceScopeIds });
  if (!analysis) return [];
  const key = decisionKey({ action, invoiceId, paymentId: excerptPaymentId });
  if (decisions(before).some((decision) => decisionKey(decision) === key)) return [];
  const decision = decisions(after).find((candidate) => decisionKey(candidate) === key);
  if (!decision || decision.datasetRevision !== dataset.revision || !Number.isSafeInteger(decision.reviewRevision) || decision.reviewRevision <= before.revision || decision.reviewRevision > after.revision || !Number.isFinite(Date.parse(decision.at))) return [];
  try {
    reconcile(dataset, after);
  } catch {
    return [];
  }
  return [{ invoiceId, paymentId: excerptPaymentId, action, datasetRevision: decision.datasetRevision, reviewRevision: decision.reviewRevision, capturedAt: decision.at, excerpt: analysis.context.excerpt, excerptPaymentId, invoiceContexts: Object.fromEntries(analysis.context.invoices.filter((invoice) => invoice.context.trim()).map((invoice) => [invoice.id, invoice.context])), ...(analysis.context.invoiceScope ? { invoiceScopeIds: analysis.context.invoices.map((invoice) => invoice.id) } : {}), investigation: structuredClone(analysis.response) }];
}

export function pruneDecisionEvidence(evidence: DecisionEvidence[], dataset: Dataset, review: ReviewState): DecisionEvidence[] {
  const active = new Map(decisions(review).map((decision) => [decisionKey(decision), decision]));
  const kept = new Map<string, DecisionEvidence>();
  for (const record of evidence) {
    const key = decisionKey(record);
    const decision = active.get(key);
    if (kept.has(key) || !decision || record.datasetRevision !== dataset.revision || decision.datasetRevision !== record.datasetRevision || decision.reviewRevision !== record.reviewRevision || decision.at !== record.capturedAt || record.reviewRevision > review.revision || !recordedInvestigation(record, dataset)) continue;
    kept.set(key, record);
  }
  return [...kept.values()];
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function money(value: number | null): string {
  return value === null ? "Unknown" : escapeHtml(formatMoney(value));
}

function facts(values: [string, string | number][]): string {
  return `<dl class="facts">${values.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function range(start: string | undefined, end: string | undefined): string {
  return start ? `${start}${end && end !== start ? ` → ${end}` : ""}` : "Not supplied";
}

function sourcePanel(title: string, source: SourceInfo | null): string {
  const providerIdentity = source?.kind === "paypal" && source.providerVerified ? source.accountIdentity : null;
  return `<section class="source"><h3>${escapeHtml(title)}</h3>${facts([
    ["Source", source?.kind === "sample" ? "Sample dataset" : source?.kind === "paypal" ? "PayPal sandbox response" : source?.kind === "file" ? "Imported file" : "Not supplied"],
    ["Label", source?.label ?? "Not supplied"], ["Coverage", source?.coverage ?? "unknown"],
    ["Provider verified", source?.kind === "paypal" && source.providerVerified ? "Only observations returned by the sandbox API" : "No"],
    ["Observed record span", range(source?.rangeStart, source?.rangeEnd)], ["Requested query window", range(source?.requestedRangeStart, source?.requestedRangeEnd)],
    ["Fetched at", source?.fetchedAt ?? "Not supplied"], ["Provider account identity", providerIdentity ? `${providerIdentity.kind}: ${providerIdentity.value}` : "Not supplied"],
    ["Unsupported records", source?.unsupportedCount ?? 0], ["Exact duplicates excluded", source?.duplicateCount ?? 0],
  ])}<h4>Query filters</h4>${source?.filters?.length ? facts(source.filters.map((filter) => [filter.field, filter.value || "Not supplied"])) : '<p class="muted">Not supplied.</p>'}</section>`;
}

function isAdjustment(payment: Payment): boolean {
  return payment.kind === "refund" || payment.kind === "reversal" || ["refunded", "partially_refunded", "reversed"].includes(payment.status);
}

function invoiceEvidence(invoice: Invoice): InvestigationRequest["invoices"][number] {
  return { id: invoice.id, amountMinor: invoice.amountMinor, currency: invoice.currency, dueDate: invoice.dueDate, customerGroup: null, context: "" };
}

function paymentEvidence(payment: Payment): InvestigationRequest["payments"][number] {
  return { id: payment.id, grossMinor: payment.grossMinor, feeMinor: payment.feeMinor, netMinor: payment.netMinor, currency: payment.currency, invoiceId: payment.invoiceId, status: payment.status, kind: payment.kind, eventCode: payment.eventCode, customerGroup: null };
}

function candidateAssessmentPanel(analysis: ValidatedInvestigation, historical: boolean): string {
  const assessments = analysis.response.proposal.candidateAssessments;
  if (assessments === undefined) return "";
  const { context } = analysis;
  const included = context.invoices.length;
  const total = context.invoiceScope?.totalCandidates ?? included;
  const excluded = context.invoiceScope?.excludedCandidates ?? 0;
  const stanceLabels = historical
    ? { supports: "Supported this invoice", contradicts: "Contradicted this invoice", unknown: "No supported conclusion" }
    : { supports: "Supports this invoice", contradicts: "Contradicts this invoice", unknown: "No supported conclusion" };
  return `<section class="candidate-assessments"><h4>${historical ? "Pre-decision model assessments" : "Model assessment of supplied candidates"}</h4><p class="muted">Original investigation scope: ${escapeHtml(included)} of ${escapeHtml(total)} candidate invoices supplied; ${escapeHtml(excluded)} excluded. Assessments cover only the supplied invoices, not complete account history.${excluded ? " Excluded candidates were not assessed or rejected." : ""} These ${historical ? "were" : "are"} model interpretations of approved text, not provider-verified facts or recorded allocation decisions.</p>${assessments.map((assessment) => `<section class="candidate-assessment"><h4>${escapeHtml(assessment.invoiceId)} · ${escapeHtml(stanceLabels[assessment.stance])}</h4>${assessment.quote ? `<p><strong>Exact quoted remittance span:</strong></p><blockquote>${escapeHtml(assessment.quote)}</blockquote>` : '<p class="muted">No remittance span quoted.</p>'}${assessment.contextQuote !== null ? `<p><strong>Exact quoted approved invoice context:</strong></p><blockquote>${escapeHtml(assessment.contextQuote)}</blockquote>` : '<p class="muted">No invoice-context span quoted.</p>'}<p class="citations"><strong>Cited evidence:</strong> ${assessment.evidenceIds.map(escapeHtml).join(" · ")}</p></section>`).join("")}</section>`;
}

function analysisPanel(analysis: ValidatedInvestigation, heading: string, historical = false): string {
  const { response, context } = analysis;
  const { proposal } = response;
  const diagnosis = proposal.category === "reference_interpretation" ? `The quoted excerpt may refer to ${proposal.invoiceId}. This is a hypothesis for human review.` : proposal.category === "ambiguous" ? "The supplied evidence remains ambiguous; the model did not select an association." : "The supplied excerpt did not support an invoice association.";
  const nextStep = proposal.category === "reference_interpretation" ? "Check the original note and cited receipt, then independently confirm or reject the association." : "Leave unsupported associations unconfirmed and obtain an explicit invoice reference or further source evidence.";
  const approvedContexts = context.invoices.filter((invoice) => invoice.context.trim()).map((invoice) => `<h4>Approved context · ${escapeHtml(invoice.id)}</h4><blockquote>${escapeHtml(invoice.context)}</blockquote>`).join("");
  const scopeNotice = context.invoiceScope ? `<p class="notice"><strong>Operator-selected investigation scope.</strong> ${escapeHtml(context.invoices.length)} of ${escapeHtml(context.invoiceScope.totalCandidates)} candidate invoices were supplied; ${escapeHtml(context.invoiceScope.excludedCandidates)} were excluded from this investigation. Excluded candidates were not examined or rejected by this investigation. This interpretation is limited to the supplied subset.</p>` : "";
  return `<div class="analysis"><h3>${escapeHtml(heading)}</h3>${scopeNotice}${facts([
    ["Provider / model", `${response.provider === "codex" ? "OpenAI Codex" : "Google Gemini"} / ${response.model}`], ["Model response generated", response.generatedAt],
    ["Analysis context", `Dataset ${analysis.datasetRevision} / review ${analysis.reviewRevision}`], ["Excerpt belongs to", context.excerptPaymentId], ["Category", proposal.category],
  ])}<p>${escapeHtml(diagnosis)}</p><h4>Reviewed excerpt</h4><blockquote>${escapeHtml(context.excerpt)}</blockquote>${proposal.quote ? `<p><strong>Exact quoted remittance span:</strong> <q>${escapeHtml(proposal.quote)}</q></p>` : ""}${approvedContexts ? `<p class="muted">Invoice contexts below were provided and approved by the operator. They are unverified context, not authenticated PayPal observations.</p>${approvedContexts}` : ""}${proposal.contextQuote !== null ? `<p><strong>Exact quoted invoice context · ${escapeHtml(proposal.invoiceId ?? "")}:</strong> <q>${escapeHtml(proposal.contextQuote)}</q></p>` : ""}<p class="citations"><strong>Cited evidence:</strong> ${proposal.evidenceIds.map(escapeHtml).join(" · ")}</p>${candidateAssessmentPanel(analysis, historical)}<p><strong>${historical && proposal.candidateAssessments ? "Proposed next step at that time" : "Proposed next step"}:</strong> ${escapeHtml(nextStep)}</p><p class="muted">The model did not change amounts, create a receipt or approve an allocation.</p></div>`;
}

function decisionComparison(evidence: DecisionEvidence): string {
  const proposal = evidence.investigation.proposal;
  if (proposal.category !== "reference_interpretation") return evidence.action === "confirm" ? "The operator confirmed an association although the model did not select a supported association." : "The operator rejected this association; the model did not select a supported association.";
  if (proposal.invoiceId === evidence.invoiceId) return evidence.action === "confirm" ? "The operator confirmed the association proposed by the model." : "The operator rejected the association proposed by the model.";
  return evidence.action === "confirm" ? `The operator confirmed ${evidence.invoiceId} instead of the model's proposal for ${proposal.invoiceId}.` : `The operator rejected ${evidence.invoiceId}, consistent with the model's alternative suggestion for ${proposal.invoiceId}. This rejection did not confirm that alternative.`;
}

export function buildReviewReport(input: { dataset: Dataset; review: ReviewState; decisionEvidence?: DecisionEvidence[]; generatedAt?: string }): string {
  const { dataset, review } = input;
  const result = reconcile(dataset, review);
  const desk = buildExceptionDesk(dataset, review, result);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const currentDecisions = decisions(review).sort((a, b) => a.reviewRevision - b.reviewRevision || a.invoiceId.localeCompare(b.invoiceId));
  const retained = pruneDecisionEvidence(input.decisionEvidence ?? [], dataset, review);
  const owners = new Map(review.allocations.map((allocation) => [allocation.paymentId, allocation.invoiceId]));
  const statusLabels = { "needs-review": "Needs review", covered: "Gross covered", partial: "Confirmed partial", overpaid: "Overpayment", refund: "Refund exception", unmatched: "No eligible receipt", pending: "Receipt pending" };
  const invoiceRows = result.rows.map((row) => `<tr><td><strong>${escapeHtml(row.invoice.id)}</strong><small>${escapeHtml(row.invoice.customer)} · source row ${escapeHtml(row.invoice.sourceRow)}</small>${row.invoice.description ? `<small>${escapeHtml(row.invoice.description)}</small>` : ""}</td><td>${escapeHtml(statusLabels[row.status])}<small>${row.reasons.map(escapeHtml).join("<br>")}</small></td><td class="number">${money(row.invoice.amountMinor)}</td><td class="number">${money(row.confirmedGrossMinor)}</td><td>${row.confirmedPayments.length ? row.confirmedPayments.map((payment) => escapeHtml(payment.id)).join(", ") : "None confirmed"}</td></tr>`).join("");
  const paymentRows = dataset.payments.map((payment) => `<tr><td><strong>${escapeHtml(payment.id)}</strong><small>Provider ${escapeHtml(payment.providerId)} · source row ${escapeHtml(payment.sourceRow)}<br>${escapeHtml(payment.timestamp)}</small></td><td>${escapeHtml(payment.kind)} / ${escapeHtml(payment.status)}<small>${escapeHtml(payment.eventCode || "Event code not supplied")}</small></td><td class="number">${money(payment.grossMinor)}</td><td class="number">${money(payment.feeMinor)}</td><td class="number">${money(payment.netMinor)}</td><td>${owners.has(payment.id) ? `Confirmed → ${escapeHtml(owners.get(payment.id)!)}` : isEligibleReceipt(payment) ? "Eligible · unallocated" : "Excluded from settled coverage"}<small>Structured invoice reference: ${escapeHtml(payment.invoiceId || "Not supplied")}</small><small>${escapeHtml(payment.memo || "No remittance text supplied")}</small>${payment.referenceId ? `<small>Related ${escapeHtml(payment.referenceType ?? "record")}: ${escapeHtml(payment.referenceId)}</small>` : ""}</td></tr>`).join("");
  const findingRows = desk.findings.map((item) => `<article class="finding"><div class="record-label">${escapeHtml(item.kind.replaceAll("-", " "))} · ${escapeHtml(item.priority)} priority</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p><p><strong>Next step:</strong> ${escapeHtml(item.nextStep)}</p><p class="muted">Invoices: ${item.invoiceIds.map(escapeHtml).join(", ") || "No association established"}<br>Source records: ${item.paymentIds.map(escapeHtml).join(", ") || "None observed"}</p></article>`).join("");
  const decisionRows = currentDecisions.map((decision) => `<tr><td>${escapeHtml(decision.action)}</td><td>${escapeHtml(decision.paymentId)} → ${escapeHtml(decision.invoiceId)}</td><td>${escapeHtml(decision.at)}<small>Dataset ${escapeHtml(decision.datasetRevision)} / review ${escapeHtml(decision.reviewRevision)}</small></td><td>${escapeHtml(decision.reason)}</td></tr>`).join("");
  const recordedPanels = retained.map((evidence) => {
    const analysis = recordedInvestigation(evidence, dataset);
    if (!analysis) return "";
    return `<article class="recorded"><div class="record-label">Frozen pre-decision evidence · ${escapeHtml(evidence.paymentId)}</div><h3>${escapeHtml(evidence.action)}: ${escapeHtml(evidence.invoiceId)}</h3><p>${escapeHtml(decisionComparison(evidence))}</p><p class="muted">Human decision recorded ${escapeHtml(evidence.capturedAt)} · dataset ${escapeHtml(evidence.datasetRevision)} / review ${escapeHtml(evidence.reviewRevision)}. The proposal below describes its earlier review state.</p>${analysisPanel(analysis, "Quoted evidence available when the operator decided", true)}</article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Paper Ledger · Review report</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f7;color:#20242a;font:14px/1.55 Arial,Helvetica,sans-serif}.paper{max-width:1160px;margin:24px auto;padding:28px 32px;background:#fff;border:1px solid #d9dde2}.masthead{display:flex;justify-content:space-between;gap:20px;padding-bottom:13px;border-bottom:1px solid #b8c0c8;font-size:13px;color:#414850}.kicker,.record-label{font-size:12px;letter-spacing:0;text-transform:none;color:#5e6771}.kicker{margin:20px 0 6px}.record-label{font-weight:600}h1{font-size:26px;line-height:1.3;letter-spacing:0;margin:0 0 8px;overflow-wrap:anywhere}h2{font-size:17px;font-weight:600;margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid #d9dde2}h3{font-size:14px;margin:8px 0 10px}h4{font-size:12px;letter-spacing:0;text-transform:none;color:#5e6771;margin:15px 0 7px}p{margin:8px 0}.muted,small,.generated{color:#5e6771;font-size:12px}small{display:block;margin-top:4px;line-height:1.5}.notice{padding:11px 13px;background:#f5f6f7;border:1px solid #d9dde2;font-size:13px;margin:16px 0}.coverage{display:flex;flex-wrap:wrap;gap:10px 28px;margin:16px 0;padding:11px 0;border-block:1px solid #d9dde2}.coverage>div{flex:1;min-width:160px;padding:0;border:0}.coverage span,.coverage small{display:block;font-size:12px;color:#5e6771}.coverage strong{display:block;margin-top:3px;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}.coverage small{margin:3px 0 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;background:#f3f4f6;color:#414850;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;padding:9px 10px;border-bottom:1px solid #d9dde2}td{vertical-align:top;border-bottom:1px solid #e8ebee;padding:10px;overflow-wrap:anywhere}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.finding,.recorded{border:1px solid #d9dde2;padding:14px;margin:12px 0}.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.source{padding:14px 0;border-top:1px solid #d9dde2}.facts{margin:0}.facts>div{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e8ebee;padding:7px 0;font-size:12px;min-width:0}.facts dt{color:#5e6771}.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;max-width:65%}.analysis{padding:14px;background:#f5f6f7;margin-top:12px;border:1px solid #d9dde2;font-size:13px}.analysis h4{font-size:12px;margin:16px 0 6px}blockquote{margin:10px 0;padding:10px 12px;background:#fff;border:1px solid #d9dde2;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.citations{overflow-wrap:anywhere;font-size:12px}.comparison{font-weight:500}ul{padding-left:20px;font-size:13px}li{margin:6px 0}.footer{margin-top:26px;padding-top:13px;border-top:1px solid #d9dde2;font-size:12px;color:#5e6771}a{color:#245b88}@media(max-width:720px){.paper{margin:0;padding:20px 16px;border:0}.coverage{gap:12px 20px}.coverage>div{min-width:145px}.source-grid{display:block}.source{margin:12px 0}.masthead{flex-wrap:wrap;font-size:12px}h1{font-size:24px}.facts>div{gap:8px}.facts dd{max-width:60%}}@media print{@page{margin:16mm}body{background:#fff;font-size:10pt}.paper{margin:0;border:0;padding:0;max-width:none}.table-wrap{overflow:visible}thead{display:table-header-group}tr,.source,.finding,.analysis{break-inside:avoid}h2,h3,h4{break-after:avoid}.recorded{break-inside:auto}.coverage strong{font-size:14pt}small,.muted{color:#555}.footer{font-size:8pt}}
</style></head><body><main class="paper"><header class="masthead"><strong>Paper Ledger</strong><span>Reconciliation review report · USD</span></header><p class="kicker">Loaded evidence / human review</p><h1>${result.stats.coveredCount} of ${result.stats.invoiceCount} invoices have confirmed gross coverage</h1><p class="generated">Generated ${escapeHtml(generatedAt)} · dataset ${escapeHtml(dataset.revision)} / review ${escapeHtml(review.revision)}</p><div class="notice">This report captures the loaded records and current review decisions. It does not establish complete account history or that an unmatched invoice is unpaid. Human review does not verify an imported source. This is a local snapshot, not an accounting-system write or durable audit log.</div><div class="coverage"><div><span>Confirmed gross</span><strong>${money(result.stats.confirmedGrossMinor)}</strong><small>${review.allocations.length} explicit human allocations</small></div><div><span>Awaiting allocation</span><strong>${money(desk.unallocatedGrossMinor)}</strong><small>${desk.unallocatedReceiptCount} eligible receipts · counted once</small></div><div><span>Pending gross</span><strong>${money(desk.pendingGrossMinor)}</strong><small>Excluded from settled coverage</small></div><div><span>Refunds & reversals</span><strong>${money(desk.adjustmentGrossMinor)}</strong><small>Signed source records · review required</small></div></div><h2>Invoice ledger</h2>${invoiceRows ? `<div class="table-wrap"><table><thead><tr><th>Invoice / context</th><th>Review state</th><th class="number">Invoice amount</th><th class="number">Confirmed gross</th><th>Confirmed receipts</th></tr></thead><tbody>${invoiceRows}</tbody></table></div>` : '<p class="muted">No invoices loaded.</p>'}<h2>Open review findings · ${desk.findings.length}</h2><p class="muted">Findings can overlap. Their amounts must not be added together. A finding identifies evidence to inspect; it is not proof of an accounting error.</p>${findingRows || '<p class="muted">No findings detected within the loaded records and current decisions. This is not proof of complete reconciliation.</p>'}<h2>Human decisions · ${currentDecisions.length}</h2>${decisionRows ? `<div class="table-wrap"><table><thead><tr><th>Action</th><th>Association</th><th>Recorded / version</th><th>Reason</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">No allocations or rejections have been recorded.</p>'}<h2>Retained AI evidence · ${retained.length}</h2><p class="muted">Only validated proposals captured with active human decisions are included. Unapplied investigations are excluded. Model interpretations do not approve allocations.</p>${recordedPanels || '<p class="muted">No validated pre-decision AI evidence was retained.</p>'}<h2>All payment and adjustment records · ${dataset.payments.length}</h2>${paymentRows ? `<div class="table-wrap"><table><thead><tr><th>Original record</th><th>Event / status</th><th class="number">Signed gross</th><th class="number">Fee cost</th><th class="number">Signed net</th><th>Allocation / remittance</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : '<p class="muted">No payment records loaded.</p>'}<p class="muted">Gross is compared with invoice coverage. Fee cost and net remain separate; unknown values are not zero. Adjustment signs follow the source record. A refunded status alone does not establish a refund amount.</p><h2>Source provenance and retrieval scope</h2><div class="source-grid">${sourcePanel("Invoice collection", dataset.invoiceSource)}${sourcePanel("Payment collection", dataset.paymentSource)}</div><footer class="footer">No payments, refunds or external accounting changes were performed. Save this report separately from workspace files, which exclude AI content. Source timestamps are preserved as supplied; generated and decision times use ISO format.</footer></main></body></html>`;
}

function combinationPanel(dataset: Dataset, review: ReviewState, invoiceId: string): string {
  const result = findReceiptCombinations(dataset, review, invoiceId);
  if (result.status === "missing" || result.status === "settled" || (result.candidateCount < 2 && !result.excludedAdjustmentCount)) return "";
  const payments = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  const summary = result.status === "limit"
    ? `${result.candidateCount} eligible related receipts exceed the 24-receipt search limit. No subset was silently selected; manual review is required.`
    : `${result.totalCombinations.toLocaleString("en-US")} exact combinations among ${result.candidateCount} receipts for the remaining ${formatMoney(result.targetMinor)}. Showing ${result.combinations.length}; display order does not rank likelihood.`;
  const rows = result.combinations.map((combination) => `<tr><td>${combination.paymentIds.map((id) => `${escapeHtml(id)} · ${money(payments.get(id)!.grossMinor)}`).join("<br>")}</td><td class="number">${money(combination.grossMinor)}</td><td>${combination.competingInvoiceIds.length ? combination.competingInvoiceIds.map(escapeHtml).join(", ") : "No other current candidate invoice"}</td></tr>`).join("");
  return `<h2>Exact amount combinations · current review state</h2><p>${escapeHtml(summary)}</p><p class="muted">Arithmetic agreement is not proof of an association. Only completed, unallocated receipts with the same customer key or explicit invoice reference are searched. Conflicting references, rejected associations, linked refund/reversal receipts and amounts above the remaining balance are excluded. Fees are not deducted from invoice coverage. ${result.excludedAdjustmentCount} otherwise eligible receipts were excluded for linked adjustments.</p>${rows ? `<div class="table-wrap"><table><thead><tr><th>Receipts / original gross</th><th class="number">Combined gross</th><th>Other candidate invoices</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`;
}

export function buildCaseBrief(input: BriefInput): string {
  const { dataset, review, invoiceId } = input;
  const result = reconcile(dataset, review);
  const row = result.rows.find((candidate) => candidate.invoice.id === invoiceId);
  if (!row) throw new Error("Select an invoice before exporting its evidence brief.");
  const draftIds = input.draftPaymentIds ?? [];
  if (!unique(draftIds)) throw new Error("Select distinct draft receipts before exporting their evidence.");
  const unallocated = new Map(result.unallocatedPayments.map((payment) => [payment.id, payment]));
  const draftPayments = draftIds.map((id) => {
    const payment = unallocated.get(id);
    if (!payment || !isEligibleReceipt(payment)) throw new Error(`Draft receipt ${id} is missing, ineligible or already allocated.`);
    if (payment.invoiceId?.trim() && payment.invoiceId.trim() !== row.invoice.id) throw new Error(`Draft receipt ${id} explicitly references another invoice.`);
    return payment;
  });
  const draftIdSet = new Set(draftIds);
  const draftProviderIds = new Set(draftPayments.map((payment) => payment.providerId));
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const caseDecisions = decisions(review).filter((decision) => decision.invoiceId === invoiceId);
  const retained = pruneDecisionEvidence(input.decisionEvidence ?? [], dataset, review).filter((record) => record.invoiceId === invoiceId);
  const recorded = retained.flatMap((evidence) => {
    const analysis = recordedInvestigation(evidence, dataset);
    return analysis ? [{ evidence, analysis }] : [];
  });
  const live = currentInvestigation(dataset, review, invoiceId, input.investigation);
  const paymentIds = new Set([...row.candidatePayments.map((candidate) => candidate.payment.id), ...row.confirmedPayments.map((payment) => payment.id), ...caseDecisions.map((decision) => decision.paymentId), ...draftIds]);
  const receipts = dataset.payments.filter((payment) => paymentIds.has(payment.id));
  const providerIds = new Set(receipts.map((payment) => payment.providerId));
  const adjustments = dataset.payments.filter((payment) => isAdjustment(payment) && payment.referenceType === "TXN" && payment.referenceId !== null && providerIds.has(payment.referenceId.trim()));
  const payments = [...new Map([...receipts, ...adjustments].map((payment) => [payment.id, payment])).values()];
  const observations = buildObservations({ invoices: [invoiceEvidence(row.invoice)], payments: payments.map(paymentEvidence) });
  const currentAlternatives = result.rows.filter((candidate) => candidate.invoice.id !== invoiceId && candidate.candidatePayments.some((payment) => paymentIds.has(payment.payment.id)));
  const recordedInvoiceIds = new Set(recorded.flatMap(({ analysis }) => analysis.context.invoices.map((invoice) => invoice.id)));
  const alternatives = dataset.invoices.filter((invoice) => invoice.id !== invoiceId && (currentAlternatives.some((candidate) => candidate.invoice.id === invoice.id) || recordedInvoiceIds.has(invoice.id)));
  const summary = facts([
    ["Invoice ID", row.invoice.id], ["Customer", row.invoice.customer], ["Invoice source row", row.invoice.sourceRow], ["Due date", row.invoice.dueDate],
    ["Invoice description (imported)", row.invoice.description || "Not supplied"],
    ["Currency", row.invoice.currency], ["Review state", row.status], ["Dataset / review version", `${dataset.revision} / ${review.revision}`],
  ]);
  const paymentRows = payments.map((payment) => {
    const draftLabel = draftIdSet.has(payment.id)
      ? "Unapplied draft selection · excluded from confirmed coverage; no association recorded."
      : isAdjustment(payment) && payment.referenceType === "TXN" && payment.referenceId !== null && draftProviderIds.has(payment.referenceId.trim())
        ? "Linked to an unapplied draft receipt · invoice association unconfirmed; excluded from confirmed coverage."
        : "";
    return `<tr><td><strong>${escapeHtml(payment.id)}</strong>${draftLabel ? `<small><strong>${draftLabel}</strong></small>` : ""}<small>Provider: ${escapeHtml(payment.providerId)}<br>Source row ${escapeHtml(payment.sourceRow)} · ${escapeHtml(payment.timestamp)}</small></td><td>${escapeHtml(payment.eventCode || "Not supplied")}<small>${escapeHtml(payment.kind)} / ${escapeHtml(payment.status)}</small></td><td class="number">${money(payment.grossMinor)}</td><td class="number">${money(payment.feeMinor)}</td><td class="number">${money(payment.netMinor)}</td><td>${escapeHtml(payment.invoiceId ?? "Missing invoice reference")}<small>${escapeHtml(payment.referenceType ?? "No related ID type")}${payment.referenceId ? `: ${escapeHtml(payment.referenceId)}` : ""}</small></td></tr>`;
  }).join("");
  const alternativeRows = alternatives.map((invoice) => `<tr><td>${escapeHtml(invoice.id)}<small>Source row ${escapeHtml(invoice.sourceRow)}</small></td><td class="number">${money(invoice.amountMinor)}</td><td>${escapeHtml(invoice.dueDate)}</td><td>${currentAlternatives.some((candidate) => candidate.invoice.id === invoice.id) ? "Current loaded candidate relationship" : "Recorded pre-decision analysis; availability may have changed"}</td></tr>`).join("");
  const decisionRows = caseDecisions.map((decision) => `<tr><td>${escapeHtml(decision.action)}</td><td>${escapeHtml(decision.paymentId)} → ${escapeHtml(decision.invoiceId)}</td><td>${escapeHtml(decision.at)}<small>Dataset ${escapeHtml(decision.datasetRevision)} / review ${escapeHtml(decision.reviewRevision)}</small></td><td>${escapeHtml(decision.reason)}</td></tr>`).join("");
  const recordedPanels = recorded.map(({ evidence, analysis }) => `<article class="recorded"><div class="record-label">Frozen pre-decision evidence</div><p>This proposal was validated before the recorded decision. It is historical evidence, not an analysis of the current review state.</p>${facts([["Operator action", `${evidence.action}: ${evidence.paymentId} → ${evidence.invoiceId}`], ["Decision recorded", evidence.capturedAt], ["Decision version", `Dataset ${evidence.datasetRevision} / review ${evidence.reviewRevision}`]])}<p class="comparison">${escapeHtml(decisionComparison(evidence))}</p>${analysisPanel(analysis, "Proposal available when the operator decided", true)}</article>`).join("");
  const deterministic = observations.filter((observation) => observation.id.endsWith(":bridge") || (observation.id.endsWith(":fee") && observation.text.includes("unknown")) || (observation.id.endsWith(":net") && observation.text.includes("unknown")));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Case brief · ${escapeHtml(invoiceId)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f7;color:#20242a;font:14px/1.55 Arial,Helvetica,sans-serif}.paper{max-width:1160px;margin:24px auto;padding:28px 32px;background:#fff;border:1px solid #d9dde2}.masthead{display:flex;justify-content:space-between;gap:20px;padding-bottom:13px;border-bottom:1px solid #b8c0c8;font-size:13px;color:#414850}.kicker,.record-label{font-size:12px;letter-spacing:0;text-transform:none;color:#5e6771}.kicker{margin:20px 0 6px}.record-label{font-weight:600}h1{font-size:26px;line-height:1.3;letter-spacing:0;margin:0 0 8px;overflow-wrap:anywhere}h2{font-size:17px;font-weight:600;margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid #d9dde2}h3{font-size:14px;margin:8px 0 10px}h4{font-size:12px;letter-spacing:0;text-transform:none;color:#5e6771;margin:15px 0 7px}p{margin:8px 0}.muted,small,.generated{color:#5e6771;font-size:12px}small{display:block;margin-top:4px;line-height:1.5}.notice{padding:11px 13px;background:#f5f6f7;border:1px solid #d9dde2;font-size:13px;margin:16px 0}.coverage{display:flex;flex-wrap:wrap;gap:10px 28px;margin:16px 0;padding:11px 0;border-block:1px solid #d9dde2}.coverage>div{flex:1;min-width:160px;padding:0;border:0}.coverage span,.coverage small{display:block;font-size:12px;color:#5e6771}.coverage strong{display:block;margin-top:3px;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}.coverage small{margin:3px 0 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;background:#f3f4f6;color:#414850;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;padding:9px 10px;border-bottom:1px solid #d9dde2}td{vertical-align:top;border-bottom:1px solid #e8ebee;padding:10px;overflow-wrap:anywhere}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.finding,.recorded{border:1px solid #d9dde2;padding:14px;margin:12px 0}.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.source{padding:14px 0;border-top:1px solid #d9dde2}.facts{margin:0}.facts>div{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e8ebee;padding:7px 0;font-size:12px;min-width:0}.facts dt{color:#5e6771}.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;max-width:65%}.analysis{padding:14px;background:#f5f6f7;margin-top:12px;border:1px solid #d9dde2;font-size:13px}.analysis h4{font-size:12px;margin:16px 0 6px}blockquote{margin:10px 0;padding:10px 12px;background:#fff;border:1px solid #d9dde2;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.citations{overflow-wrap:anywhere;font-size:12px}.comparison{font-weight:500}ul{padding-left:20px;font-size:13px}li{margin:6px 0}.footer{margin-top:26px;padding-top:13px;border-top:1px solid #d9dde2;font-size:12px;color:#5e6771}a{color:#245b88}.facts{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.source .facts{display:block}@media(max-width:720px){.facts{display:block}}@media(max-width:720px){.paper{margin:0;padding:20px 16px;border:0}.coverage{gap:12px 20px}.coverage>div{min-width:145px}.source-grid{display:block}.source{margin:12px 0}.masthead{flex-wrap:wrap;font-size:12px}h1{font-size:24px}.facts>div{gap:8px}.facts dd{max-width:60%}}@media print{@page{margin:16mm}body{background:#fff;font-size:10pt}.paper{margin:0;border:0;padding:0;max-width:none}.table-wrap{overflow:visible}thead{display:table-header-group}tr,.source,.finding,.analysis{break-inside:avoid}h2,h3,h4{break-after:avoid}.recorded{break-inside:auto}.coverage strong{font-size:14pt}small,.muted{color:#555}.footer{font-size:8pt}}
</style></head><body><main class="paper"><header class="masthead"><strong>Paper Ledger</strong><span>Selected-case evidence brief · USD</span></header><p class="kicker">Reconciliation / current-tab snapshot</p><h1>${escapeHtml(invoiceId)}</h1><p class="generated">Generated ${escapeHtml(generatedAt)} · dataset ${escapeHtml(dataset.revision)} / review ${escapeHtml(review.revision)}</p><div class="notice">This is a portable snapshot of the loaded evidence and current decisions. It is not a durable audit log, an accounting-system write, or proof of complete account history. Manual review does not upgrade source verification.</div>${summary}<div class="coverage"><div><span>Invoice amount</span><strong>${money(row.invoice.amountMinor)}</strong></div><div><span>Confirmed gross</span><strong>${money(row.confirmedGrossMinor)}</strong><small>Explicit human allocations only</small></div><div><span>Suggested gross</span><strong>${money(row.suggestedGrossMinor)}</strong><small>Excluded from confirmed coverage</small></div></div>${combinationPanel(dataset, review, invoiceId)}<h2>Source payments and adjustments</h2>${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Original record / provider ID</th><th>Event / state</th><th class="number">Signed gross</th><th class="number">Fee cost</th><th class="number">Signed net</th><th>References</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : '<p class="muted">No supporting receipt was observed in the loaded data. This does not prove the invoice is unpaid.</p>'}<p class="muted">Amounts use the merchant perspective. Fee cost is positive for a charge and negative for a credited fee. Unknown values are not zero. A refunded capture's gross is its original capture amount; no refund amount is inferred from status alone.</p><h2>Deterministic observations</h2><ul><li>Only confirmed associations contribute ${money(row.confirmedGrossMinor)} to this invoice's gross coverage.</li><li>Known confirmed fee cost: ${money(row.knownFeeMinor)}. Unknown confirmed fee count: ${escapeHtml(row.unknownFeeCount)}.</li>${row.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}${deterministic.map((observation) => `<li>${escapeHtml(observation.text)}</li>`).join("")}</ul><h2>Alternative invoice relationships</h2>${alternatives.length ? `<div class="table-wrap"><table><thead><tr><th>Invoice</th><th class="number">Amount</th><th>Due date</th><th>Relationship scope</th></tr></thead><tbody>${alternativeRows}</tbody></table></div>` : '<p class="muted">No other invoice appears in the current candidate relationships or retained pre-decision analysis. Candidate search is bounded to the loaded data.</p>'}<h2>Current human review decisions</h2>${caseDecisions.length ? `<div class="table-wrap"><table><thead><tr><th>Action</th><th>Association</th><th>Recorded at / version</th><th>Reason</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">Unreviewed. No association has been confirmed or rejected for this invoice.</p>'}<h2>Current AI investigation</h2>${live ? analysisPanel(live, "Validated for this exact current case") : '<p class="muted">No current validated AI proposal is attached to this snapshot.</p>'}${recordedPanels ? `<h2>AI evidence retained with decisions</h2>${recordedPanels}` : ""}<h2>Source provenance and coverage</h2><div class="source-grid">${sourcePanel("Invoice collection", dataset.invoiceSource)}${sourcePanel("Payment collection", dataset.paymentSource)}</div><footer class="footer">Original record IDs and source row numbers identify the loaded observations. Requested windows and query filters describe retrieval scope; observed spans describe returned records. No payment, refund or external accounting action was performed by this brief.</footer></main></body></html>`;
}
