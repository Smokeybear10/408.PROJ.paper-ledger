import { z } from "zod";
import { MAX_ROWS, idSchema, investigationContextSchema, investigationRequestSchema, investigationResponseSchema, type Dataset, type DecisionEvidence, type InvestigationRequest, type InvestigationResponse, type Invoice, type Payment, type ReviewState, type SourceInfo } from "./contracts";
import { buildInvestigationRequest, buildObservations, formatMoney, isEligibleReceipt, reconcile } from "./reconciliation";
import { buildExceptionDesk } from "./case-intelligence";

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
const normalizedReference = (value: string) => value.normalize("NFKC").trim().toUpperCase();
const decisionKey = (decision: Pick<Decision, "action" | "invoiceId" | "paymentId">) => JSON.stringify([decision.action, decision.invoiceId, decision.paymentId]);

function decisions(review: ReviewState): Decision[] {
  return [
    ...review.allocations.map((decision) => ({ ...decision, action: "confirm" as const, at: decision.confirmedAt })),
    ...review.rejections.map((decision) => ({ ...decision, action: "reject" as const, at: decision.rejectedAt })),
  ];
}

function validProposal(response: InvestigationResponse, context: InvestigationRequest): boolean {
  const { proposal } = response;
  const invoiceIds = new Set(context.invoices.map((invoice) => invoice.id));
  const payments = new Map(context.payments.map((payment) => [payment.id, payment]));
  const evidenceIds = new Set([...context.invoices.map((invoice) => `invoice:${invoice.id}`), ...context.invoices.filter((invoice) => invoice.context.trim()).map((invoice) => `context:${invoice.id}`), ...context.payments.map((payment) => `payment:${payment.id}`), "memo:selected"]);
  const observations = buildObservations(context);
  const observationIds = new Set(observations.map((observation) => observation.id));
  const owner = payments.get(context.excerptPaymentId);
  if (!owner || !isEligibleReceipt(owner) || !unique(context.invoices.map((invoice) => invoice.id)) || !unique(context.payments.map((payment) => payment.id))) return false;
  if (!unique(proposal.paymentIds) || !unique(proposal.evidenceIds) || !unique(proposal.observationIds) || proposal.evidenceIds.some((id) => !evidenceIds.has(id)) || proposal.observationIds.some((id) => !observationIds.has(id))) return false;
  if (JSON.stringify(response.observations) !== JSON.stringify(observations) || (proposal.quote && !context.excerpt.includes(proposal.quote))) return false;
  if (proposal.category !== "reference_interpretation") return proposal.invoiceId === null && proposal.interpretedReference === null && proposal.contextQuote === null && proposal.paymentIds.length === 0;
  if (!proposal.invoiceId || !invoiceIds.has(proposal.invoiceId) || !proposal.interpretedReference || normalizedReference(proposal.interpretedReference) !== normalizedReference(proposal.invoiceId) || !proposal.quote.trim()) return false;
  const invoice = context.invoices.find((candidate) => candidate.id === proposal.invoiceId);
  const contextCitations = proposal.evidenceIds.filter((id) => id.startsWith("context:"));
  if (proposal.contextQuote !== null) {
    if (!invoice || !proposal.contextQuote.trim() || !invoice.context.includes(proposal.contextQuote) || !contextCitations.includes(`context:${invoice.id}`) || contextCitations.some((id) => id !== `context:${invoice.id}`)) return false;
  } else if (contextCitations.length) return false;
  return proposal.paymentIds.length === 1 && proposal.paymentIds[0] === context.excerptPaymentId
    && proposal.evidenceIds.includes("memo:selected") && proposal.evidenceIds.includes(`invoice:${proposal.invoiceId}`) && proposal.evidenceIds.includes(`payment:${context.excerptPaymentId}`)
    && (!owner.invoiceId || normalizedReference(owner.invoiceId) === normalizedReference(proposal.invoiceId));
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

export function retainedInvestigationScope(evidence: DecisionEvidence, dataset: Dataset) {
  const analysis = recordedInvestigation(evidence, dataset);
  if (!analysis) return null;
  const included = analysis.context.invoices.length;
  return {
    included,
    total: analysis.context.invoiceScope?.totalCandidates ?? included,
    excluded: analysis.context.invoiceScope?.excludedCandidates ?? 0,
    payments: analysis.context.payments.length,
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

function analysisPanel(analysis: ValidatedInvestigation, heading: string): string {
  const { response, context } = analysis;
  const { proposal } = response;
  const diagnosis = proposal.category === "reference_interpretation" ? `The quoted excerpt may refer to ${proposal.invoiceId}. This is a hypothesis for human review.` : proposal.category === "ambiguous" ? "The supplied evidence remains ambiguous; the model did not select an association." : "The supplied excerpt did not support an invoice association.";
  const nextStep = proposal.category === "reference_interpretation" ? "Check the original note and cited receipt, then independently confirm or reject the association." : "Leave unsupported associations unconfirmed and obtain an explicit invoice reference or further source evidence.";
  const approvedContexts = context.invoices.filter((invoice) => invoice.context.trim()).map((invoice) => `<h4>Approved context · ${escapeHtml(invoice.id)}</h4><blockquote>${escapeHtml(invoice.context)}</blockquote>`).join("");
  const scopeNotice = context.invoiceScope ? `<p class="notice"><strong>Operator-selected investigation scope.</strong> ${escapeHtml(context.invoices.length)} of ${escapeHtml(context.invoiceScope.totalCandidates)} candidate invoices were supplied; ${escapeHtml(context.invoiceScope.excludedCandidates)} were excluded from this investigation. Excluded candidates were not examined or rejected by this investigation. This interpretation is limited to the supplied subset.</p>` : "";
  return `<div class="analysis"><h3>${escapeHtml(heading)}</h3>${scopeNotice}${facts([
    ["Provider / model", `${response.provider === "codex" ? "OpenAI Codex" : "Google Gemini"} / ${response.model}`], ["Model response generated", response.generatedAt],
    ["Analysis context", `Dataset ${analysis.datasetRevision} / review ${analysis.reviewRevision}`], ["Excerpt belongs to", context.excerptPaymentId], ["Category", proposal.category],
  ])}<p>${escapeHtml(diagnosis)}</p><h4>Reviewed excerpt</h4><blockquote>${escapeHtml(context.excerpt)}</blockquote>${proposal.quote ? `<p><strong>Exact quoted remittance span:</strong> <q>${escapeHtml(proposal.quote)}</q></p>` : ""}${approvedContexts ? `<p class="muted">Invoice contexts below were provided and approved by the operator. They are unverified context, not authenticated PayPal observations.</p>${approvedContexts}` : ""}${proposal.contextQuote !== null ? `<p><strong>Exact quoted invoice context · ${escapeHtml(proposal.invoiceId ?? "")}:</strong> <q>${escapeHtml(proposal.contextQuote)}</q></p>` : ""}<p class="citations"><strong>Cited evidence:</strong> ${proposal.evidenceIds.map(escapeHtml).join(" · ")}</p><p><strong>Proposed next step:</strong> ${escapeHtml(nextStep)}</p><p class="muted">The model did not change amounts, create a receipt or approve an allocation.</p></div>`;
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
    return `<article class="recorded"><div class="record-label">Frozen pre-decision evidence · ${escapeHtml(evidence.paymentId)}</div><h3>${escapeHtml(evidence.action)}: ${escapeHtml(evidence.invoiceId)}</h3><p>${escapeHtml(decisionComparison(evidence))}</p><p class="muted">Human decision recorded ${escapeHtml(evidence.capturedAt)} · dataset ${escapeHtml(evidence.datasetRevision)} / review ${escapeHtml(evidence.reviewRevision)}. The proposal below describes its earlier review state.</p>${analysisPanel(analysis, "Quoted evidence available when the operator decided")}</article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Paper Ledger · Review report</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#203047;font:14px/1.6 "Helvetica Neue",Arial,sans-serif}.paper{max-width:1160px;margin:32px auto;padding:40px 44px;background:white;border:1px solid #dce3ec}.masthead{display:flex;justify-content:space-between;gap:20px;padding-bottom:16px;border-bottom:2px solid #234e81;font-size:12px}.kicker,.record-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#55708e}h1{font-size:34px;line-height:1.2;letter-spacing:-1px;margin:24px 0 8px}h2{font-size:20px;margin:32px 0 14px;padding-bottom:8px;border-bottom:1px solid #dce3ec}h3{font-size:15px;margin:8px 0}p{margin:8px 0}.muted,small,.generated{color:#566b83;font-size:12px}small{display:block;margin-top:4px;line-height:1.5}.notice{padding:14px 18px;background:#edf3fa;border:1px solid #d8e3f0;margin:20px 0}.coverage{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid #dce3ec;padding:18px 0;gap:20px}.coverage span,.coverage small{display:block;font-size:12px;color:#566b83}.coverage strong{font-size:26px;font-weight:500;font-variant-numeric:tabular-nums}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:#f4f7fb;color:#566b83;font-size:11px;font-weight:500;padding:10px}td{vertical-align:top;border-bottom:1px solid #e0e6ef;padding:13px 10px;overflow-wrap:anywhere}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.finding,.recorded{border:1px solid #dce3ec;padding:18px;margin:12px 0}.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.source{padding:18px;border:1px solid #dce3ec}.facts{margin:0}.facts>div{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e0e6ef;padding:7px 0;font-size:12px}.facts dt{color:#566b83}.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;max-width:65%}.analysis{padding:16px;background:#f4f7fb;margin-top:14px;border:1px solid #dce3ec}.analysis h4{font-size:12px;margin:18px 0 6px}blockquote{margin:10px 0;padding:12px 16px;background:white;border:1px solid #dce3ec;white-space:pre-wrap;overflow-wrap:anywhere}.citations{overflow-wrap:anywhere;font-size:12px}.footer{margin-top:30px;padding-top:14px;border-top:1px solid #dce3ec;font-size:12px;color:#566b83}@media(max-width:720px){.paper{margin:0;padding:24px 18px;border:0}.coverage{grid-template-columns:1fr 1fr}.coverage strong{font-size:23px}.source-grid{display:block}.source{margin:12px 0}.masthead{flex-wrap:wrap}h1{font-size:28px}.facts>div{gap:8px}.facts dd{max-width:60%}}@media print{@page{margin:16mm}body{background:white}.paper{margin:0;border:0;padding:0;max-width:none}.table-wrap{overflow:visible}thead{display:table-header-group}tr,.source,.finding{break-inside:avoid}h2,h3,h4{break-after:avoid}.recorded{break-inside:auto}.coverage strong{font-size:20px}}
</style></head><body><main class="paper"><header class="masthead"><strong>Paper Ledger</strong><span>Reconciliation review report · USD</span></header><p class="kicker">Loaded evidence / human review</p><h1>${result.stats.coveredCount} of ${result.stats.invoiceCount} invoices have confirmed gross coverage</h1><p class="generated">Generated ${escapeHtml(generatedAt)} · dataset ${escapeHtml(dataset.revision)} / review ${escapeHtml(review.revision)}</p><div class="notice">This report captures the loaded records and current review decisions. It does not establish complete account history or that an unmatched invoice is unpaid. Human review does not verify an imported source. This is a local snapshot, not an accounting-system write or durable audit log.</div><div class="coverage"><div><span>Confirmed gross</span><strong>${money(result.stats.confirmedGrossMinor)}</strong><small>${review.allocations.length} explicit human allocations</small></div><div><span>Awaiting allocation</span><strong>${money(desk.unallocatedGrossMinor)}</strong><small>${desk.unallocatedReceiptCount} eligible receipts · counted once</small></div><div><span>Pending gross</span><strong>${money(desk.pendingGrossMinor)}</strong><small>Excluded from settled coverage</small></div><div><span>Refunds & reversals</span><strong>${money(desk.adjustmentGrossMinor)}</strong><small>Signed source records · review required</small></div></div><h2>Invoice ledger</h2>${invoiceRows ? `<div class="table-wrap"><table><thead><tr><th>Invoice / context</th><th>Review state</th><th class="number">Invoice amount</th><th class="number">Confirmed gross</th><th>Confirmed receipts</th></tr></thead><tbody>${invoiceRows}</tbody></table></div>` : '<p class="muted">No invoices loaded.</p>'}<h2>Open review findings · ${desk.findings.length}</h2><p class="muted">Findings can overlap. Their amounts must not be added together. A finding identifies evidence to inspect; it is not proof of an accounting error.</p>${findingRows || '<p class="muted">No findings detected within the loaded records and current decisions. This is not proof of complete reconciliation.</p>'}<h2>Human decisions · ${currentDecisions.length}</h2>${decisionRows ? `<div class="table-wrap"><table><thead><tr><th>Action</th><th>Association</th><th>Recorded / version</th><th>Reason</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">No allocations or rejections have been recorded.</p>'}<h2>Retained AI evidence · ${retained.length}</h2><p class="muted">Only validated proposals captured with active human decisions are included. Unapplied investigations are excluded. Model interpretations do not approve allocations.</p>${recordedPanels || '<p class="muted">No validated pre-decision AI evidence was retained.</p>'}<h2>All payment and adjustment records · ${dataset.payments.length}</h2>${paymentRows ? `<div class="table-wrap"><table><thead><tr><th>Original record</th><th>Event / status</th><th class="number">Signed gross</th><th class="number">Fee cost</th><th class="number">Signed net</th><th>Allocation / remittance</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : '<p class="muted">No payment records loaded.</p>'}<p class="muted">Gross is compared with invoice coverage. Fee cost and net remain separate; unknown values are not zero. Adjustment signs follow the source record. A refunded status alone does not establish a refund amount.</p><h2>Source provenance and retrieval scope</h2><div class="source-grid">${sourcePanel("Invoice collection", dataset.invoiceSource)}${sourcePanel("Payment collection", dataset.paymentSource)}</div><footer class="footer">No payments, refunds or external accounting changes were performed. Save this report separately from workspace files, which exclude AI content. Source timestamps are preserved as supplied; generated and decision times use ISO format.</footer></main></body></html>`;
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
  const recordedPanels = recorded.map(({ evidence, analysis }) => `<article class="recorded"><div class="record-label">Frozen pre-decision evidence</div><p>This proposal was validated before the recorded decision. It is historical evidence, not an analysis of the current review state.</p>${facts([["Operator action", `${evidence.action}: ${evidence.paymentId} → ${evidence.invoiceId}`], ["Decision recorded", evidence.capturedAt], ["Decision version", `Dataset ${evidence.datasetRevision} / review ${evidence.reviewRevision}`]])}<p class="comparison">${escapeHtml(decisionComparison(evidence))}</p>${analysisPanel(analysis, "Proposal available when the operator decided")}</article>`).join("");
  const deterministic = observations.filter((observation) => observation.id.endsWith(":bridge") || (observation.id.endsWith(":fee") && observation.text.includes("unknown")) || (observation.id.endsWith(":net") && observation.text.includes("unknown")));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Case brief · ${escapeHtml(invoiceId)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f3ec;color:#293126;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.paper{max-width:1080px;margin:36px auto;background:#fffef9;padding:44px 48px;border:1px solid #dedfd1}.masthead{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #566348;padding-bottom:15px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6f7965}.kicker{font-size:10px;letter-spacing:1.5px;color:#748066;text-transform:uppercase;margin:26px 0 5px}h1{font-size:32px;line-height:1.2;letter-spacing:-1px;margin:0 0 8px;overflow-wrap:anywhere}h2{font-size:17px;font-weight:600;margin:28px 0 12px;border-bottom:1px solid #dfe3d4;padding-bottom:8px}h3{font-size:13px;margin:0 0 12px}h4{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#748066;margin:15px 0 7px}p{margin:9px 0}small{display:block;color:#78816f;font-size:10px;line-height:1.65;margin-top:4px}.muted{color:#78816f;font-size:11px}.notice{padding:12px 15px;background:#edf0e4;border:1px solid #dce2cc;font-size:11px;margin:18px 0}.facts{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:0 25px}.facts>div{display:flex;justify-content:space-between;gap:15px;border-bottom:1px solid #e9ebdf;padding:7px 0;font-size:11px;min-width:0}.facts dt{color:#7b8371;flex-shrink:0}.facts dd{margin:0;text-align:right;overflow-wrap:anywhere;font-weight:500}.coverage{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:18px 0}.coverage>div{padding:12px 15px;border:1px solid #dfe4d3}.coverage span{display:block;color:#7b8371;font-size:10px}.coverage strong{font-size:20px;font-weight:500;font-variant-numeric:tabular-nums}.coverage small{margin:3px 0 0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:11px}th{font-size:9px;letter-spacing:.5px;text-transform:uppercase;font-weight:500;color:#7a826d;text-align:left;padding:9px;border-bottom:1px solid #cfd8bf;background:#f2f4e9}td{vertical-align:top;padding:11px 9px;border-bottom:1px solid #e4e8d9;overflow-wrap:anywhere}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}ul{padding-left:20px;font-size:12px}li{margin:7px 0}.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:25px}.source{border:1px solid #dfe4d4;padding:17px}.source .facts{display:block}.analysis{padding:18px;border:1px solid #d7dfc7;background:#f5f7ed;margin-top:12px;font-size:12px}blockquote{border-left:2px solid #899a72;margin:10px 0;padding:9px 13px;background:#fffef8;white-space:pre-wrap;overflow-wrap:anywhere}.citations{font-size:10px;overflow-wrap:anywhere}.recorded{padding:18px;border:1px dashed #b9bea9;margin:16px 0;font-size:12px}.record-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:600;color:#758164}.comparison{font-weight:500}.footer{border-top:1px solid #dce1d1;margin-top:30px;padding-top:14px;font-size:10px;color:#818875}.generated{font-size:11px;color:#818875}a{color:inherit}@media(max-width:720px){.paper{margin:0;padding:24px 18px;border:0}.facts,.source-grid{display:block}.source{margin-bottom:14px}.coverage{gap:7px}.coverage>div{padding:9px}.coverage strong{font-size:16px}.masthead{font-size:9px}.facts dd{max-width:65%}h1{font-size:27px}}@media print{@page{margin:17mm}body{background:#fff;font-size:10pt}.paper{max-width:none;margin:0;padding:0;border:0}.table-wrap{overflow:visible}thead{display:table-header-group}tr,.source,.analysis{break-inside:avoid}.recorded{break-inside:auto}h2,h3,h4{break-after:avoid}.coverage strong{font-size:15pt}.facts,.source-grid{gap:18px}small,.muted{color:#555}th{background:#f4f4ed}.footer{font-size:8pt}}
</style></head><body><main class="paper"><header class="masthead"><strong>Paper Ledger</strong><span>Selected-case evidence brief · USD</span></header><p class="kicker">Reconciliation / current-tab snapshot</p><h1>${escapeHtml(invoiceId)}</h1><p class="generated">Generated ${escapeHtml(generatedAt)} · dataset ${escapeHtml(dataset.revision)} / review ${escapeHtml(review.revision)}</p><div class="notice">This is a portable snapshot of the loaded evidence and current decisions. It is not a durable audit log, an accounting-system write, or proof of complete account history. Manual review does not upgrade source verification.</div>${summary}<div class="coverage"><div><span>Invoice amount</span><strong>${money(row.invoice.amountMinor)}</strong></div><div><span>Confirmed gross</span><strong>${money(row.confirmedGrossMinor)}</strong><small>Explicit human allocations only</small></div><div><span>Suggested gross</span><strong>${money(row.suggestedGrossMinor)}</strong><small>Excluded from confirmed coverage</small></div></div><h2>Source payments and adjustments</h2>${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Original record / provider ID</th><th>Event / state</th><th class="number">Signed gross</th><th class="number">Fee cost</th><th class="number">Signed net</th><th>References</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : '<p class="muted">No supporting receipt was observed in the loaded data. This does not prove the invoice is unpaid.</p>'}<p class="muted">Amounts use the merchant perspective. Fee cost is positive for a charge and negative for a credited fee. Unknown values are not zero. A refunded capture's gross is its original capture amount; no refund amount is inferred from status alone.</p><h2>Deterministic observations</h2><ul><li>Only confirmed associations contribute ${money(row.confirmedGrossMinor)} to this invoice's gross coverage.</li><li>Known confirmed fee cost: ${money(row.knownFeeMinor)}. Unknown confirmed fee count: ${escapeHtml(row.unknownFeeCount)}.</li>${row.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}${deterministic.map((observation) => `<li>${escapeHtml(observation.text)}</li>`).join("")}</ul><h2>Alternative invoice relationships</h2>${alternatives.length ? `<div class="table-wrap"><table><thead><tr><th>Invoice</th><th class="number">Amount</th><th>Due date</th><th>Relationship scope</th></tr></thead><tbody>${alternativeRows}</tbody></table></div>` : '<p class="muted">No other invoice appears in the current candidate relationships or retained pre-decision analysis. Candidate search is bounded to the loaded data.</p>'}<h2>Current human review decisions</h2>${caseDecisions.length ? `<div class="table-wrap"><table><thead><tr><th>Action</th><th>Association</th><th>Recorded at / version</th><th>Reason</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">Unreviewed. No association has been confirmed or rejected for this invoice.</p>'}<h2>Current AI investigation</h2>${live ? analysisPanel(live, "Validated for this exact current case") : '<p class="muted">No current validated AI proposal is attached to this snapshot.</p>'}${recordedPanels ? `<h2>AI evidence retained with decisions</h2>${recordedPanels}` : ""}<h2>Source provenance and coverage</h2><div class="source-grid">${sourcePanel("Invoice collection", dataset.invoiceSource)}${sourcePanel("Payment collection", dataset.paymentSource)}</div><footer class="footer">Original record IDs and source row numbers identify the loaded observations. Requested windows and query filters describe retrieval scope; observed spans describe returned records. No payment, refund or external accounting action was performed by this brief.</footer></main></body></html>`;
}
