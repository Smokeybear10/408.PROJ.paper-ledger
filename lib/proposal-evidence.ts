import { proposalSchema, type InvestigationRequest, type Proposal } from "./contracts";
import { buildObservations, isEligibleReceipt } from "./reconciliation";

export type ProposalEvidenceContext = Pick<InvestigationRequest, "invoices" | "payments" | "excerpt" | "excerptPaymentId">;
export type ProposalEvidenceFailure = { path: string; reason: string };
type RejectEvidence = (path: string, reason: string) => false;

const unique = (values: string[]) => new Set(values).size === values.length;
const normalizedReference = (value: string) => value.normalize("NFKC").trim().toUpperCase();

export function proposalEvidenceIds(context: ProposalEvidenceContext): string[] {
  return [...context.invoices.map((invoice) => `invoice:${invoice.id}`), ...context.invoices.filter((invoice) => invoice.context.trim()).map((invoice) => `context:${invoice.id}`), ...context.payments.map((payment) => `payment:${payment.id}`), "memo:selected"];
}

function quoteNamesInvoice(quote: string, invoiceId: string): boolean {
  const reference = normalizedReference(invoiceId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${reference}($|[^\\p{L}\\p{N}_-])`, "u").test(normalizedReference(quote));
}

export function proposalEvidenceConflicts(proposal: Proposal, context: ProposalEvidenceContext): { structuredReferenceConflict: boolean; contradictedInvoiceIds: string[] } {
  const reference = normalizedReference(context.payments.find((payment) => payment.id === context.excerptPaymentId)?.invoiceId ?? "");
  const invoiceIds = new Set(context.invoices.map((invoice) => invoice.id));
  const assessments = proposal.candidateAssessments?.filter((assessment) => invoiceIds.has(assessment.invoiceId)) ?? [];
  return {
    structuredReferenceConflict: Boolean(reference && ((proposal.category === "reference_interpretation" && proposal.invoiceId && normalizedReference(proposal.invoiceId) !== reference) || assessments.some((assessment) => assessment.stance === "supports" && normalizedReference(assessment.invoiceId) !== reference || assessment.stance === "contradicts" && normalizedReference(assessment.invoiceId) === reference))),
    contradictedInvoiceIds: assessments.filter((assessment) => assessment.stance === "contradicts").map((assessment) => assessment.invoiceId),
  };
}

function validAssessments(proposal: Proposal, context: ProposalEvidenceContext, required: boolean, reject: RejectEvidence): boolean {
  const assessments = proposal.candidateAssessments;
  if (!assessments) return !required || reject("candidateAssessments", "missing required assessments");
  if (assessments.length !== context.invoices.length) return reject("candidateAssessments", "must cover every supplied invoice");
  if (!unique(assessments.map((assessment) => assessment.invoiceId))) return reject("candidateAssessments.invoiceId", "duplicate invoice IDs");
  for (const [index, assessment] of assessments.entries()) {
    const path = `candidateAssessments[${index}]`;
    const invoice = context.invoices.find((candidate) => candidate.id === assessment.invoiceId);
    if (!invoice) return reject(`${path}.invoiceId`, "invoice was not supplied");
    if (!unique(assessment.evidenceIds)) return reject(`${path}.evidenceIds`, "duplicate citations");
    if (assessment.quote && !context.excerpt.includes(assessment.quote)) return reject(`${path}.quote`, "not an exact span of the approved note");
    const requiredIds = [`invoice:${invoice.id}`, `payment:${context.excerptPaymentId}`, "memo:selected"];
    const allowedIds = new Set([...requiredIds, ...(invoice.context.trim() ? [`context:${invoice.id}`] : [])]);
    if (requiredIds.some((id) => !assessment.evidenceIds.includes(id))) return reject(`${path}.evidenceIds`, "missing required invoice, receipt or note citation");
    if (assessment.evidenceIds.some((id) => !allowedIds.has(id))) return reject(`${path}.evidenceIds`, "citation belongs to another candidate or unsupplied evidence");
    if (assessment.stance === "unknown") {
      if (assessment.contextQuote !== null) return reject(`${path}.contextQuote`, "unknown assessments must not quote identifying context");
      if (assessment.evidenceIds.includes(`context:${invoice.id}`)) return reject(`${path}.evidenceIds`, "unknown assessments must not cite identifying context");
      continue;
    }
    if (!assessment.quote.trim()) return reject(`${path}.quote`, "support or contradiction requires a nonempty note span");
    if (assessment.contextQuote !== null) {
      if (!assessment.contextQuote.trim() || !invoice.context.includes(assessment.contextQuote)) return reject(`${path}.contextQuote`, "not a nonempty exact span of this invoice's approved context");
      if (!assessment.evidenceIds.includes(`context:${invoice.id}`)) return reject(`${path}.evidenceIds`, "missing this invoice's context citation");
    } else {
      if (assessment.evidenceIds.includes(`context:${invoice.id}`)) return reject(`${path}.contextQuote`, "context citation requires its exact quoted span");
      if (!quoteNamesInvoice(assessment.quote, invoice.id)) return reject(`${path}.quote`, "direct evidence must contain this invoice's whole literal ID");
    }
  }
  const supported = assessments.filter((assessment) => assessment.stance === "supports");
  return proposal.category !== "reference_interpretation" || supported.length === 1 && supported[0].invoiceId === proposal.invoiceId || reject("candidateAssessments", "a suggestion requires exactly one supported invoice matching its target");
}

export function validateProposalEvidence(value: Proposal, context: ProposalEvidenceContext, options: { requireAssessments?: boolean; onFailure?: (failure: ProposalEvidenceFailure) => void } = {}): boolean {
  const reject: RejectEvidence = (path, reason) => {
    options.onFailure?.({ path, reason });
    return false;
  };
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) return reject("proposal", "invalid response format");
  const proposal = parsed.data;
  const owner = context.payments.find((payment) => payment.id === context.excerptPaymentId);
  if (!owner || !isEligibleReceipt(owner)) return reject("excerptPaymentId", "note owner is not a supplied eligible receipt");
  if (!unique(context.invoices.map((invoice) => invoice.id))) return reject("invoices", "duplicate supplied invoice IDs");
  if (!unique(context.payments.map((payment) => payment.id))) return reject("payments", "duplicate supplied payment IDs");
  const evidenceIds = new Set(proposalEvidenceIds(context));
  const observationIds = new Set(buildObservations(context).map((observation) => observation.id));
  if (!unique(proposal.paymentIds)) return reject("paymentIds", "duplicate receipt IDs");
  if (!unique(proposal.evidenceIds)) return reject("evidenceIds", "duplicate citations");
  if (!unique(proposal.observationIds)) return reject("observationIds", "duplicate observation IDs");
  if (proposal.evidenceIds.some((id) => !evidenceIds.has(id))) return reject("evidenceIds", "citation was not supplied");
  if (proposal.observationIds.some((id) => !observationIds.has(id))) return reject("observationIds", "observation was not supplied");
  if (proposal.quote && !context.excerpt.includes(proposal.quote)) return reject("quote", "not an exact span of the approved note");
  if (!validAssessments(proposal, context, options.requireAssessments ?? false, reject)) return false;
  if (proposal.category !== "reference_interpretation") {
    if (proposal.invoiceId !== null) return reject("invoiceId", "an abstention must not select an invoice");
    if (proposal.interpretedReference !== null) return reject("interpretedReference", "an abstention must not select a reference");
    if (proposal.contextQuote !== null) return reject("contextQuote", "an abstention must not quote target context");
    return proposal.paymentIds.length === 0 || reject("paymentIds", "an abstention must not select receipts");
  }
  const invoice = context.invoices.find((candidate) => candidate.id === proposal.invoiceId);
  if (!invoice) return reject("invoiceId", "target invoice was not supplied");
  if (!proposal.interpretedReference || normalizedReference(proposal.interpretedReference) !== normalizedReference(invoice.id)) return reject("interpretedReference", "reference does not match the target invoice");
  if (!proposal.quote.trim()) return reject("quote", "a suggestion requires a nonempty note span");
  if (proposal.paymentIds.length !== 1 || proposal.paymentIds[0] !== context.excerptPaymentId) return reject("paymentIds", "a suggestion must select only the receipt owning this note");
  if (!proposal.evidenceIds.includes("memo:selected") || !proposal.evidenceIds.includes(`invoice:${invoice.id}`) || !proposal.evidenceIds.includes(`payment:${context.excerptPaymentId}`)) return reject("evidenceIds", "missing required target invoice, receipt or note citation");
  const contextCitations = proposal.evidenceIds.filter((id) => id.startsWith("context:"));
  if (proposal.contextQuote !== null) {
    if (!proposal.contextQuote.trim() || !invoice.context.includes(proposal.contextQuote)) return reject("contextQuote", "not a nonempty exact span of the target invoice's approved context");
    if (!contextCitations.includes(`context:${invoice.id}`) || contextCitations.some((id) => id !== `context:${invoice.id}`)) return reject("evidenceIds", "context citations must belong only to the target invoice");
  } else if (contextCitations.length) return reject("contextQuote", "context citation requires its exact quoted span");
  if (owner.invoiceId && normalizedReference(owner.invoiceId) !== normalizedReference(invoice.id)) return reject("invoiceId", "target conflicts with the receipt's structured reference");
  return !proposalEvidenceConflicts(proposal, context).structuredReferenceConflict || reject("candidateAssessments", "interpretation conflicts with the receipt's structured reference");
}
