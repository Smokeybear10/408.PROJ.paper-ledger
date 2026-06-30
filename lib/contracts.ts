import { z } from "zod";

export const MAX_MINOR = 1_000_000_000;
export const MAX_ROWS = 1_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const idSchema = z.string().trim().min(1).max(100);
export const moneySchema = z.number().int().min(-MAX_MINOR).max(MAX_MINOR).refine(Number.isSafeInteger);
export const currencySchema = z.literal("USD");
const rawSchema = z.record(z.string(), z.string()).optional();

export const invoiceSchema = z.object({
  id: idSchema,
  customer: z.string().trim().min(1).max(240),
  customerKey: z.string().max(240),
  description: z.string().max(500).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: moneySchema.refine((value) => value > 0),
  currency: currencySchema,
  sourceRow: z.number().int().positive(),
  raw: rawSchema,
});

export const paymentStatusSchema = z.enum(["completed", "pending", "refunded", "partially_refunded", "reversed", "failed", "unsupported"]);
export const paymentKindSchema = z.enum(["receipt", "refund", "reversal", "fee", "other"]);
export const paymentSchema = z.object({
  id: idSchema,
  providerId: idSchema,
  eventCode: z.string().max(64),
  referenceId: z.string().max(100).nullable(),
  referenceType: z.enum(["TXN", "ODR", "SUB", "PAP"]).nullable(),
  invoiceId: z.string().max(100).nullable(),
  customerKey: z.string().max(240).nullable(),
  status: paymentStatusSchema,
  kind: paymentKindSchema,
  grossMinor: moneySchema,
  feeMinor: moneySchema.nullable(),
  netMinor: moneySchema.nullable(),
  currency: currencySchema,
  timestamp: z.string().min(1).max(64),
  memo: z.string().max(4096),
  sourceRow: z.number().int().positive(),
  raw: rawSchema,
});

export const sourceInfoSchema = z.object({
  kind: z.enum(["sample", "file", "paypal"]),
  label: z.string().min(1).max(240),
  coverage: z.enum(["sample", "file-defined", "bounded-window", "single-record", "partial", "unknown"]),
  rangeStart: z.string().max(64).optional(),
  rangeEnd: z.string().max(64).optional(),
  requestedRangeStart: z.string().max(64).optional(),
  requestedRangeEnd: z.string().max(64).optional(),
  filters: z.array(z.object({ field: z.string().min(1).max(100), value: z.string().max(240) }).strict()).max(10).optional(),
  accountIdentity: z.object({ kind: z.enum(["account_number", "merchant_id"]), value: idSchema }).strict().nullable().optional(),
  fetchedAt: z.string().max(64).optional(),
  unsupportedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  providerVerified: z.boolean(),
});

export type Invoice = z.infer<typeof invoiceSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type SourceInfo = z.infer<typeof sourceInfoSchema>;
export type ImportIssue = { row: number; message: string };
export type ColumnMapping = Record<string, string>;
export type ImportResult<T> = { records: T[]; issues: ImportIssue[]; duplicateCount: number };
type DecisionVersion = { datasetRevision: number; reviewRevision: number };
export type Allocation = DecisionVersion & { invoiceId: string; paymentId: string; reason: string; confirmedAt: string };
export type Rejection = DecisionVersion & { invoiceId: string; paymentId: string; reason: string; rejectedAt: string };
export type ReviewState = { allocations: Allocation[]; rejections: Rejection[]; revision: number };
export type Dataset = { invoices: Invoice[]; payments: Payment[]; invoiceSource: SourceInfo | null; paymentSource: SourceInfo | null; revision: number };
export type CandidatePayment = { payment: Payment; match: "reference" | "customer" | "amount"; reason: string; eligible: boolean };
export type InvoiceResult = {
  invoice: Invoice;
  candidatePayments: CandidatePayment[];
  confirmedPayments: Payment[];
  confirmedGrossMinor: number;
  suggestedGrossMinor: number;
  knownFeeMinor: number;
  unknownFeeCount: number;
  status: "needs-review" | "covered" | "partial" | "overpaid" | "refund" | "unmatched" | "pending";
  reasons: string[];
};
export type Reconciliation = {
  rows: InvoiceResult[];
  unallocatedPayments: Payment[];
  stats: { invoiceCount: number; needsReviewCount: number; coveredCount: number; confirmedGrossMinor: number; totalInvoiceMinor: number; knownFeeMinor: number; unknownFeeCount: number };
};

export const paypalConnectionRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("connect"), clientId: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/).refine((value) => !value.includes(":")), clientSecret: z.string().trim().min(1).max(2048).regex(/^[!-~]+$/) }).strict(),
  z.object({ operation: z.literal("disconnect") }).strict(),
]);
export const paypalConnectionStatusSchema = z.object({
  connected: z.boolean(),
  authenticated: z.boolean(),
  source: z.enum(["environment", "memory"]).nullable(),
  connectionId: z.uuid().nullable(),
}).strict().refine((value) => value.connected ? value.connectionId !== null && value.source !== null : value.connectionId === null && value.source === null && !value.authenticated);
export const paypalRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capture"), captureId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), connectionId: z.uuid() }).strict(),
  z.object({ operation: z.literal("transactions"), startDate: z.string().min(1).max(64), endDate: z.string().min(1).max(64), connectionId: z.uuid() }).strict(),
]);
export const paypalApiRequestSchema = z.union([paypalConnectionRequestSchema, paypalRequestSchema]);
export const paypalResponseSchema = z.object({ payments: z.array(paymentSchema).max(MAX_ROWS), source: sourceInfoSchema, connectionId: z.uuid() });
export type PayPalConnectionRequest = z.infer<typeof paypalConnectionRequestSchema>;
export type PayPalConnectionStatus = z.infer<typeof paypalConnectionStatusSchema>;
export type PayPalRequest = z.infer<typeof paypalRequestSchema>;
export type PayPalResponse = z.infer<typeof paypalResponseSchema>;

export const evidenceInvoiceSchema = invoiceSchema.pick({ id: true, amountMinor: true, currency: true, dueDate: true }).extend({ customerGroup: z.string().max(40).nullable(), context: z.string().max(500).default("").transform((value) => value.trim() ? value : "") }).strict();
export const evidencePaymentSchema = paymentSchema.pick({ id: true, grossMinor: true, feeMinor: true, netMinor: true, currency: true, invoiceId: true, status: true, kind: true, eventCode: true }).extend({ customerGroup: z.string().max(40).nullable() }).strict();
export const investigationContextSchema = z.object({
  caseId: idSchema,
  invoices: z.array(evidenceInvoiceSchema).min(1).max(20),
  payments: z.array(evidencePaymentSchema).min(1).max(20),
  excerpt: z.string().trim().min(1).max(1200),
  excerptPaymentId: idSchema,
  invoiceScope: z.object({ totalCandidates: z.number().int().min(2).max(MAX_ROWS), excludedCandidates: z.number().int().min(1).max(MAX_ROWS - 1) }).strict().optional(),
}).strict();
export const investigationRequestSchema = investigationContextSchema.extend({
  requestId: z.string().min(1).max(100),
  fingerprint: z.string().min(1).max(32768),
}).refine((value) => !value.invoiceScope || value.invoiceScope.totalCandidates === value.invoices.length + value.invoiceScope.excludedCandidates, { path: ["invoiceScope"], message: "The selected and excluded invoice counts must equal the total candidate count." });
export const investigationApiRequestSchema = investigationRequestSchema.safeExtend({ expectedProvider: z.enum(["codex", "gemini"]) });
export const proposalSchema = z.object({
  invoiceId: idSchema.nullable(),
  paymentIds: z.array(idSchema).max(5),
  evidenceIds: z.array(z.string().min(1).max(240)).min(1).max(20),
  quote: z.string().max(240),
  contextQuote: z.string().max(240).nullable().default(null),
  interpretedReference: z.string().max(100).nullable(),
  category: z.enum(["reference_interpretation", "no_supported_match", "ambiguous"]),
  observationIds: z.array(z.string().min(1).max(300)).max(20),
}).strict();
export const observationSchema = z.object({ id: z.string(), text: z.string(), evidenceIds: z.array(z.string()) });
export const investigationResponseSchema = z.object({
  proposal: proposalSchema,
  observations: z.array(observationSchema),
  provider: z.enum(["gemini", "codex"]),
  model: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  generatedAt: z.string(),
});
export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;
export type InvestigationResponse = z.infer<typeof investigationResponseSchema>;
export type DecisionEvidence = {
  invoiceId: string;
  paymentId: string;
  action: "confirm" | "reject";
  datasetRevision: number;
  reviewRevision: number;
  capturedAt: string;
  excerpt: string;
  excerptPaymentId: string;
  invoiceContexts: Record<string, string>;
  invoiceScopeIds?: string[];
  investigation: InvestigationResponse;
};
export type Proposal = z.infer<typeof proposalSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ApiError = { error: { code: string; message: string } };
