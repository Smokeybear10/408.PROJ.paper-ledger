import { z } from "zod";
import { MAX_ROWS, invoiceSchema, paymentSchema, sourceInfoSchema, type Dataset, type ReviewState, type SourceInfo } from "./contracts";
import { confirmAllocation, isEligibleReceipt, reconcile } from "./reconciliation";

export const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;

export type RestoredWorkspace = {
  dataset: Dataset;
  review: ReviewState;
  selectedInvoiceId: string | null;
  savedAt: string;
};

const RESTORED_PREFIX = "Restored workspace · ";
const revisionSchema = z.number().int().nonnegative().max(1_000_000_000, "Revision counters must be at most 1,000,000,000 so later actions can increment safely.").refine(Number.isSafeInteger);
const safePositiveInteger = z.number().int().positive().refine(Number.isSafeInteger, "Use a safe integer.");
const safeCount = z.number().int().nonnegative().refine(Number.isSafeInteger, "Use a safe integer.");
const canonicalId = z.string().min(1).max(100).refine((value) => value === value.trim(), "IDs must be nonempty and have no surrounding whitespace.");

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !validDate(value.slice(0, 10))) return false;
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  return hour < 24 && minute < 60 && second < 60 && (!offset || (Number(offset[1]) < 24 && Number(offset[2]) < 60)) && Number.isFinite(Date.parse(value));
}

const dateSchema = z.string().refine(validDate, "Use a real calendar date in YYYY-MM-DD format.");
const timestampSchema = z.string().max(64).refine(validTimestamp, "Use a valid ISO timestamp with a time zone.");
const paymentDateSchema = z.string().max(64).refine((value) => validDate(value) || validTimestamp(value), "Use a valid ISO date or timestamp with a time zone.");
const reasonSchema = z.string().min(1).max(4096).refine((value) => value.trim().length > 0, "A review decision needs a reason.");

const storedInvoiceSchema = invoiceSchema.extend({
  id: canonicalId,
  customer: z.string().min(1).max(240).refine((value) => value.trim().length > 0, "A customer name is required."),
  dueDate: dateSchema,
  sourceRow: safePositiveInteger,
}).strict();
const storedPaymentSchema = paymentSchema.extend({ id: canonicalId, providerId: canonicalId, timestamp: paymentDateSchema, sourceRow: safePositiveInteger }).strict();
const storedSourceSchema = sourceInfoSchema.extend({ unsupportedCount: safeCount, duplicateCount: safeCount }).strict();
const allocationSchema = z.object({ invoiceId: canonicalId, paymentId: canonicalId, reason: reasonSchema, confirmedAt: timestampSchema, datasetRevision: revisionSchema, reviewRevision: revisionSchema }).strict();
const rejectionSchema = z.object({ invoiceId: canonicalId, paymentId: canonicalId, reason: reasonSchema, rejectedAt: timestampSchema, datasetRevision: revisionSchema, reviewRevision: revisionSchema }).strict();
const datasetSchema = z.object({
  invoices: z.array(storedInvoiceSchema).max(MAX_ROWS),
  payments: z.array(storedPaymentSchema).max(MAX_ROWS),
  invoiceSource: storedSourceSchema.nullable(),
  paymentSource: storedSourceSchema.nullable(),
  revision: revisionSchema,
}).strict();
const reviewSchema = z.object({ allocations: z.array(allocationSchema).max(MAX_ROWS), rejections: z.array(rejectionSchema).max(MAX_ROWS * MAX_ROWS), revision: revisionSchema }).strict();
const workspaceSchema = z.object({ format: z.literal("paper-ledger-workspace"), version: z.literal(1), savedAt: timestampSchema, dataset: datasetSchema, review: reviewSchema, selectedInvoiceId: canonicalId.nullable() }).strict();
const saveSchema = workspaceSchema.extend({
  dataset: datasetSchema.extend({ invoices: z.array(storedInvoiceSchema.strip()).max(MAX_ROWS), payments: z.array(storedPaymentSchema.strip()).max(MAX_ROWS), invoiceSource: storedSourceSchema.strip().nullable(), paymentSource: storedSourceSchema.strip().nullable() }).strip(),
  review: reviewSchema.extend({ allocations: z.array(allocationSchema.strip()).max(MAX_ROWS), rejections: z.array(rejectionSchema.strip()).max(MAX_ROWS * MAX_ROWS) }).strip(),
}).strip();

type StoredWorkspace = z.infer<typeof workspaceSchema>;

function checkBytes(text: string): void {
  if (text.length > MAX_WORKSPACE_BYTES || new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_BYTES) throw new Error("Workspace files must be 16 MB or smaller.");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function checkCollectionLimits(value: unknown): void {
  const snapshot = record(value);
  const dataset = record(snapshot?.dataset);
  const review = record(snapshot?.review);
  const invoices = Array.isArray(dataset?.invoices) ? dataset.invoices : null;
  const payments = Array.isArray(dataset?.payments) ? dataset.payments : null;
  if ((invoices?.length ?? 0) > MAX_ROWS || (payments?.length ?? 0) > MAX_ROWS) throw new Error("A workspace may contain at most 1,000 invoices and 1,000 payments.");
  if (Array.isArray(review?.allocations) && review.allocations.length > (payments?.length ?? MAX_ROWS)) throw new Error("A workspace cannot contain more confirmed allocations than payment records.");
  const possiblePairs = (invoices?.length ?? MAX_ROWS) * (payments?.length ?? MAX_ROWS);
  if (Array.isArray(review?.rejections) && review.rejections.length > possiblePairs) throw new Error("The rejection list exceeds the number of distinct invoice/payment pairs.");
}

function validateWorkspace(value: unknown, saving = false): StoredWorkspace {
  checkCollectionLimits(value);
  const parsed = (saving ? saveSchema : workspaceSchema).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.map(String).join(".") || "workspace";
    throw new Error(`Invalid workspace ${path}: ${issue.message}`);
  }
  const snapshot = parsed.data;
  const { dataset, review } = snapshot;
  const invoices = new Map(dataset.invoices.map((invoice) => [invoice.id, invoice]));
  const payments = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  if (invoices.size !== dataset.invoices.length || payments.size !== dataset.payments.length) throw new Error("Workspace record IDs must be unique within each collection.");
  if (snapshot.selectedInvoiceId !== null && !invoices.has(snapshot.selectedInvoiceId)) throw new Error("The saved selected invoice is missing from this workspace.");
  dataset.payments.forEach((payment) => {
    if (payment.feeMinor !== null && payment.netMinor !== null && (!Number.isSafeInteger(payment.grossMinor - payment.feeMinor) || payment.grossMinor - payment.feeMinor !== payment.netMinor)) throw new Error(`Payment ${payment.id} has contradictory gross, fee and net values.`);
  });
  const confirmations = new Set<string>();
  const rejections = new Set<string>();
  const groupedAllocations = new Map<string, string[]>();
  const validateDecision = (decision: ReviewState["allocations"][number] | ReviewState["rejections"][number]) => {
    if (!invoices.has(decision.invoiceId) || !payments.has(decision.paymentId)) throw new Error("A saved review decision references an invoice or payment that is missing.");
    if (decision.datasetRevision !== dataset.revision) throw new Error("A saved decision belongs to a different dataset revision.");
    if (decision.reviewRevision === 0) throw new Error("Saved review decisions must have a positive review revision.");
    if (decision.reviewRevision > review.revision) throw new Error("A saved decision is newer than the workspace review revision.");
  };
  review.allocations.forEach((decision) => {
    validateDecision(decision);
    const pair = JSON.stringify([decision.invoiceId, decision.paymentId]);
    if (confirmations.has(pair)) throw new Error("The workspace contains a duplicate confirmation for the same invoice/payment pair.");
    confirmations.add(pair);
    groupedAllocations.set(decision.invoiceId, [...(groupedAllocations.get(decision.invoiceId) ?? []), decision.paymentId]);
  });
  review.rejections.forEach((decision) => {
    validateDecision(decision);
    const pair = JSON.stringify([decision.invoiceId, decision.paymentId]);
    if (rejections.has(pair)) throw new Error("The workspace contains a duplicate rejection for the same invoice/payment pair.");
    if (confirmations.has(pair)) throw new Error("The same invoice/payment pair cannot be both confirmed and rejected.");
    rejections.add(pair);
  });
  groupedAllocations.forEach((paymentIds, invoiceId) => {
    const invoice = invoices.get(invoiceId);
    if (!invoice) return;
    const selected = paymentIds.flatMap((paymentId) => payments.get(paymentId) ?? []);
    confirmAllocation({ ...dataset, invoices: [invoice], payments: selected }, { allocations: [], rejections: [], revision: 0 }, invoiceId, paymentIds);
  });
  reconcile(dataset, review);
  return snapshot;
}

function restoredLabel(original: string | undefined, fallback: string): string {
  let label = original ?? fallback;
  while (label.startsWith(RESTORED_PREFIX)) label = label.slice(RESTORED_PREFIX.length);
  return `${RESTORED_PREFIX}${label.trim() || fallback}`.slice(0, 240);
}

function observedRange(values: string[]): { rangeStart?: string; rangeEnd?: string } {
  if (!values.length) return {};
  const sorted = [...values].sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b));
  return { rangeStart: sorted[0], rangeEnd: sorted[sorted.length - 1] };
}

function restoreSource(original: SourceInfo | null, values: string[], fallback: string, unsupportedCount: number): SourceInfo | null {
  if (original === null && !values.length) return null;
  return { kind: "file", label: restoredLabel(original?.label, fallback), coverage: "file-defined", providerVerified: false, unsupportedCount, duplicateCount: 0, ...observedRange(values) };
}

export function serializeWorkspace(dataset: Dataset, review: ReviewState, selectedInvoiceId: string | null, savedAt = new Date().toISOString()): string {
  const snapshot = validateWorkspace({ format: "paper-ledger-workspace", version: 1, savedAt, dataset, review, selectedInvoiceId }, true);
  const text = JSON.stringify(snapshot, null, 2);
  checkBytes(text);
  return text;
}

export function parseWorkspace(text: string): RestoredWorkspace {
  checkBytes(text);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("This file is not valid workspace JSON. Choose a saved Paper Ledger workspace file."); }
  const snapshot = validateWorkspace(value);
  const { dataset } = snapshot;
  const unsupportedCount = dataset.payments.filter((payment) => payment.status === "unsupported" || payment.kind === "other" || (payment.status === "completed" && payment.kind === "receipt" && !isEligibleReceipt(payment))).length;
  return {
    savedAt: snapshot.savedAt,
    selectedInvoiceId: snapshot.selectedInvoiceId,
    review: snapshot.review,
    dataset: {
      ...dataset,
      invoiceSource: restoreSource(dataset.invoiceSource, dataset.invoices.map((invoice) => invoice.dueDate), "Invoices", 0),
      paymentSource: restoreSource(dataset.paymentSource, dataset.payments.map((payment) => payment.timestamp), "Payments", unsupportedCount),
    },
  };
}
