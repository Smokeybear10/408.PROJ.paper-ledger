import Papa from "papaparse";
import {
  MAX_FILE_BYTES,
  MAX_MINOR,
  MAX_ROWS,
  evidenceInvoiceSchema,
  invoiceSchema,
  investigationRequestSchema,
  paymentSchema,
  type CandidatePayment,
  type ColumnMapping,
  type Dataset,
  type ImportIssue,
  type ImportResult,
  type InvestigationRequest,
  type Invoice,
  type InvoiceResult,
  type Observation,
  type Payment,
  type Reconciliation,
  type ReviewState,
} from "./contracts";

export const EMPTY_REVIEW: ReviewState = { allocations: [], rejections: [], revision: 0 };

const RECEIPT_EVENTS = new Set([
  "T0000", "T0006", "CAPTURE", "RECEIPT", "PAYMENT_RECEIVED", "EXPRESS_CHECKOUT_PAYMENT", "GENERAL_PAYMENT", "WEB_ACCEPT_PAYMENT",
]);
const REFUND_EVENTS = new Set(["T1107", "REFUND", "PAYMENT_REFUND"]);
const REVERSAL_EVENTS = new Set(["REVERSAL", "PAYMENT_REVERSAL"]);
const FEE_EVENTS = new Set(["FEE", "PAYPAL_FEE"]);
const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, "");
const normalizeEvent = (value: string) => value.trim().toUpperCase().replace(/[\s-]+/g, "_");
const reference = (value: string | null) => value?.trim() ?? "";
const customerKey = (value: string | null) => value?.trim().toLowerCase() ?? "";
const observationKey = (payment: Payment) => JSON.stringify([payment.providerId, normalizeEvent(payment.eventCode)]);
const dollarFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function safeSum(values: number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) throw new Error("A financial total exceeds the supported integer range.");
    return total + value;
  }, 0);
}

export function parseMoney(text: string): number {
  const value = text.trim();
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Use a decimal amount with at most two decimal places; no currency symbols, grouping or exponents.");
  const unsigned = value.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (whole.length > 12) throw new Error("Amount exceeds the supported limit of $10,000,000.00.");
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(magnitude) || magnitude > MAX_MINOR) throw new Error("Amount exceeds the supported limit of $10,000,000.00.");
  return magnitude === 0 ? 0 : value.startsWith("-") ? -magnitude : magnitude;
}

export function formatMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Money must be a safe integer number of minor units.");
  return dollarFormatter.format(minor / 100);
}

function decimalMoney(minor: number | null): string {
  if (minor === null) return "";
  if (!Number.isSafeInteger(minor)) throw new Error("Money must be a safe integer number of minor units.");
  const magnitude = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

type CsvData = { headers: string[]; rows: string[][]; issues: ImportIssue[] };

function readCsv(text: string): CsvData {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) return { headers: [], rows: [], issues: [{ row: 1, message: "Files must be 2 MB or smaller." }] };
  const delimiter = Papa.parse<string[]>(text, { preview: 1, skipEmptyLines: "greedy" }).meta.delimiter;
  const parts: string[] = [];
  let quoted = false;
  let fieldStart = true;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (index === 0 && character === "\uFEFF") continue;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { index += 1; continue; }
      if (quoted || fieldStart) { quoted = !quoted; fieldStart = false; }
      continue;
    }
    if (quoted) continue;
    if (character === "\r") {
      parts.push(text.slice(start, index), "\n");
      if (text[index + 1] === "\n") index += 1;
      start = index + 1;
      fieldStart = true;
      continue;
    }
    fieldStart = character === "\n" || character === delimiter;
  }
  const normalized = parts.length ? parts.join("") + text.slice(start) : text;
  const parsed = Papa.parse<string[]>(normalized, { skipEmptyLines: "greedy", newline: "\n" });
  const [first = [], ...rows] = parsed.data;
  const headers = first.map((header) => header.replace(/^\uFEFF/, "").trim());
  const issues: ImportIssue[] = parsed.errors.map((error) => ({ row: (error.row ?? 0) + 1, message: error.message }));
  if (!headers.length) issues.push({ row: 1, message: "The CSV must contain a header row and at least one data row." });
  if (!rows.length) issues.push({ row: 2, message: "The CSV has no data rows." });
  if (rows.length > MAX_ROWS) issues.push({ row: MAX_ROWS + 2, message: `Files may contain at most ${MAX_ROWS.toLocaleString("en-US")} data rows.` });
  const seen = new Set<string>();
  for (const header of headers) {
    const key = normalizeHeader(header);
    if (!key) issues.push({ row: 1, message: "Every CSV column needs a nonempty header." });
    if (seen.has(key)) issues.push({ row: 1, message: `Duplicate or ambiguous header: ${header}.` });
    seen.add(key);
  }
  return { headers, rows, issues };
}

export function getCsvHeaders(text: string): string[] {
  return readCsv(text).headers;
}

const invoiceAliases: Record<string, string[]> = {
  id: ["invoice_id", "invoice id", "invoice", "id", "invoice number", "Invoice Number Text"],
  customer: ["customer", "customer_name", "customer name", "client", "name"],
  customerKey: ["customer_key", "customer_id", "customer email", "customer_email", "email"],
  description: ["description", "invoice_description", "invoice description", "service_description", "service description", "item_description", "item description", "project"],
  amount: ["amount", "invoice_amount", "total", "invoice total"],
  currency: ["currency", "currency_code"],
  dueDate: ["due_date", "due date", "due", "dueDate"],
};

const paymentAliases: Record<string, string[]> = {
  id: ["payment_id", "id", "record_key"],
  providerId: ["provider_id", "transaction_id", "transaction id", "capture_id", "provider transaction id"],
  eventCode: ["event_code", "transaction_event_code", "event type", "type"],
  kind: ["kind", "payment_kind"],
  status: ["status", "transaction_status"],
  timestamp: ["timestamp", "transaction_initiation_date", "date", "payment_date"],
  currency: ["currency", "currency_code"],
  gross: ["gross", "gross_amount", "amount"],
  fee: ["fee_cost", "fee", "fee_amount"],
  net: ["net", "net_amount"],
  invoiceId: ["invoice_id", "invoice number text", "invoice number", "invoice reference"],
  referenceId: ["reference_id", "reference txn id", "reference transaction id", "related_transaction_id", "paypal_reference_id"],
  referenceType: ["reference_type", "paypal_reference_id_type"],
  balanceImpact: ["balance impact", "balance_impact"],
  customerKey: ["customer_key", "customer_id", "payer_id", "from email address", "payer_email", "customer email"],
  memo: ["memo", "note", "subject", "transaction_subject", "remittance"],
};

function columns(headers: string[], aliases: Record<string, string[]>, mapping: ColumnMapping, required: string[]): { indexes: Record<string, number>; issues: ImportIssue[] } {
  const indexes: Record<string, number> = {};
  const issues: ImportIssue[] = [];
  for (const [field, names] of Object.entries(aliases)) {
    const mapped = mapping[field];
    const index = mapped !== undefined
      ? headers.indexOf(mapped)
      : names.map((name) => headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(name))).find((found) => found >= 0) ?? -1;
    if (mapped !== undefined && index < 0) issues.push({ row: 1, message: `Mapped column “${mapped}” for ${field} was not found.` });
    if (required.includes(field) && index < 0) issues.push({ row: 1, message: `Missing required column: ${field}. Choose its mapping before importing.` });
    indexes[field] = index;
  }
  return { indexes, issues };
}

export type PaymentImportProfile = {
  format: "paypal-activity" | "normalized";
  label: string;
  feeMode: "bridge-verified" | "fee-cost";
  hasBalanceImpact: boolean;
  notes: string[];
};

function paymentImportProfile(headers: string[], indexes: Record<string, number>): PaymentImportProfile {
  const normalized = new Set(headers.map(normalizeHeader));
  const activity = ["date", "time", "timezone", "type", "status", "currency", "gross", "fee", "net", "transactionid"].every((field) => normalized.has(field));
  const feeMode = activity && normalizeHeader(headers[indexes.fee] ?? "") === "fee" ? "bridge-verified" : "fee-cost";
  const hasBalanceImpact = indexes.balanceImpact >= 0;
  return {
    format: activity ? "paypal-activity" : "normalized",
    label: activity ? "US PayPal Activity columns" : "Normalized payment CSV",
    feeMode,
    hasBalanceImpact,
    notes: activity ? [
      "US dates use MM/DD/YYYY. Supplied times require a supported US time zone, UTC/GMT or a numeric offset.",
      feeMode === "bridge-verified" ? "Fee signs are accepted only when Gross, Fee and Net prove the exact bridge. A nonzero Fee without Net requires correction." : "The mapped fee column is a signed fee cost: gross minus fee cost must equal net when both are supplied.",
      hasBalanceImpact ? "Memo rows and incompatible balance directions remain unsupported evidence, outside invoice coverage." : "Balance Impact is not supplied. Only recognized completed incoming receipt types can support coverage.",
      "The file stays unverified. Unknown event types and invoice-only statuses do not establish settled receipts.",
    ] : [
      "Dates use ISO format. Fee cost is positive for a charge and negative for a credited fee; unknown fee/net values stay unknown.",
      "The file stays unverified. Unknown event types do not establish settled receipts.",
    ],
  };
}

export function getPaymentImportProfile(text: string, mapping: ColumnMapping = {}): PaymentImportProfile {
  const csv = readCsv(text);
  const resolved = columns(csv.headers, paymentAliases, mapping, []);
  return paymentImportProfile(csv.headers, resolved.indexes);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function paymentDate(value: string, raw: Record<string, string>, activity: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const time = value.slice(11, 19).split(":").map(Number);
    const offset = value.match(/[+-](\d{2}):(\d{2})$/);
    if (validDate(value.slice(0, 10)) && time[0] < 24 && time[1] < 60 && time[2] < 60 && (!offset || (Number(offset[1]) < 24 && Number(offset[2]) < 60)) && Number.isFinite(Date.parse(value))) return value;
  }
  if (activity) {
    const date = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const iso = date ? `${date[3]}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}` : value;
    if (validDate(iso)) {
      const time = Object.entries(raw).find(([key]) => normalizeHeader(key) === "time")?.[1].trim() ?? "";
      if (!time) return iso;
      if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) throw new Error("US PayPal Activity Time must use HH:MM:SS.");
      const zone = Object.entries(raw).find(([key]) => normalizeHeader(key) === "timezone")?.[1].trim().toUpperCase() ?? "";
      const offsets: Record<string, string> = { UTC: "Z", GMT: "Z", PST: "-08:00", PDT: "-07:00", MST: "-07:00", MDT: "-06:00", CST: "-06:00", CDT: "-05:00", EST: "-05:00", EDT: "-04:00" };
      const offset = offsets[zone] ?? (/^[+-]\d{2}:\d{2}$/.test(zone) ? zone : "");
      if (offset) return paymentDate(`${iso}T${time}${offset}`, {}, false);
      throw new Error("US PayPal Activity TimeZone must be a supported US abbreviation, UTC/GMT or a numeric offset such as -05:00.");
    }
  }
  if (validDate(value)) return value;
  throw new Error("Use an ISO date or timestamp, or a US PayPal Activity date with a supported time zone.");
}

function schemaIssues(row: number, issues: { path: PropertyKey[]; message: string }[]): ImportIssue[] {
  return issues.map((issue) => ({ row, message: `${issue.path.join(".") || "Row"}: ${issue.message}` }));
}

function rawRow(headers: string[], values: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

export function parseInvoiceCsv(text: string, mapping: ColumnMapping = {}): ImportResult<Invoice> {
  const csv = readCsv(text);
  if (csv.issues.length) return { records: [], issues: csv.issues, duplicateCount: 0 };
  const resolved = columns(csv.headers, invoiceAliases, mapping, ["id", "customer", "currency", "amount", "dueDate"]);
  if (resolved.issues.length) return { records: [], issues: resolved.issues, duplicateCount: 0 };
  const records: Invoice[] = [];
  const issues: ImportIssue[] = [];
  const ids = new Map<string, number>();
  csv.rows.forEach((values, index) => {
    const row = index + 2;
    if (values.length !== csv.headers.length) { issues.push({ row, message: "The number of cells does not match the header row." }); return; }
    const get = (field: string) => values[resolved.indexes[field]]?.trim() ?? "";
    try {
      const dueDate = get("dueDate");
      if (!validDate(dueDate)) throw new Error("dueDate: Use a valid ISO date in YYYY-MM-DD format.");
      const parsed = invoiceSchema.safeParse({ id: get("id"), customer: get("customer"), customerKey: get("customerKey") || get("customer").toLowerCase(), ...(resolved.indexes.description >= 0 ? { description: get("description") } : {}), currency: get("currency"), amountMinor: parseMoney(get("amount")), dueDate, sourceRow: row, raw: rawRow(csv.headers, values) });
      if (!parsed.success) { issues.push(...schemaIssues(row, parsed.error.issues)); return; }
      const previous = ids.get(parsed.data.id);
      if (previous !== undefined) issues.push({ row, message: `Invoice ID ${parsed.data.id} also appears on row ${previous}; invoice IDs must be unique.` });
      ids.set(parsed.data.id, row);
      records.push(parsed.data);
    } catch (error) {
      issues.push({ row, message: error instanceof Error ? error.message : "Invalid invoice row." });
    }
  });
  return { records, issues, duplicateCount: 0 };
}

function normalizeStatus(value: string): Payment["status"] {
  const status = normalizeEvent(value);
  if (["S", "COMPLETED", "COMPLETE", "SUCCESS", "SUCCESSFUL", "PROCESSED"].includes(status)) return "completed";
  if (["P", "PENDING", "PROCESSING", "CREATED", "PAYMENT_PENDING"].includes(status)) return "pending";
  if (status === "REFUNDED") return "refunded";
  if (status === "PARTIALLY_REFUNDED") return "partially_refunded";
  if (["V", "REVERSED"].includes(status)) return "reversed";
  if (["D", "FAILED", "DENIED", "CANCELED", "CANCELLED", "VOIDED", "DECLINED"].includes(status)) return "failed";
  return "unsupported";
}

function eventKind(code: string): Payment["kind"] {
  const event = normalizeEvent(code);
  if (RECEIPT_EVENTS.has(event)) return "receipt";
  if (REFUND_EVENTS.has(event)) return "refund";
  if (REVERSAL_EVENTS.has(event)) return "reversal";
  if (FEE_EVENTS.has(event)) return "fee";
  return "other";
}

function observationValue(payment: Payment): string {
  const { id: _id, sourceRow: _row, raw: _raw, ...value } = payment;
  return JSON.stringify(value);
}

export function parsePaymentCsv(text: string, mapping: ColumnMapping = {}): ImportResult<Payment> {
  const csv = readCsv(text);
  if (csv.issues.length) return { records: [], issues: csv.issues, duplicateCount: 0 };
  const resolved = columns(csv.headers, paymentAliases, mapping, ["providerId", "timestamp", "status", "currency", "gross"]);
  if (resolved.issues.length) return { records: [], issues: resolved.issues, duplicateCount: 0 };
  const profile = paymentImportProfile(csv.headers, resolved.indexes);
  const activity = profile.format === "paypal-activity";
  const invoiceReferenceHeaders = new Set(paymentAliases.invoiceId.map(normalizeHeader));
  const invoiceReferenceIndexes = mapping.invoiceId === undefined && activity ? csv.headers.flatMap((header, index) => invoiceReferenceHeaders.has(normalizeHeader(header)) ? [index] : []) : [resolved.indexes.invoiceId];
  const records: Payment[] = [];
  const issues: ImportIssue[] = [];
  const observations = new Map<string, Payment>();
  const explicitIds = new Set<Payment>();
  let duplicateCount = 0;
  csv.rows.forEach((values, index) => {
    const row = index + 2;
    if (values.length !== csv.headers.length) { issues.push({ row, message: "The number of cells does not match the header row." }); return; }
    const get = (field: string) => values[resolved.indexes[field]]?.trim() ?? "";
    const amount = (value: string) => {
      if (activity && /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(value)) return parseMoney(value.replaceAll(",", ""));
      return parseMoney(value);
    };
    const optionalAmount = (value: string) => !value || /^(unknown|null)$/i.test(value) ? null : amount(value);
    try {
      const raw = rawRow(csv.headers, values);
      const grossMinor = amount(get("gross"));
      const rawKind = normalizeEvent(get("kind"));
      const suppliedKind: Payment["kind"] | null = !rawKind ? null : ["RECEIPT", "PAYMENT", "CAPTURE", "SALE"].includes(rawKind) ? "receipt" : rawKind === "REFUND" ? "refund" : rawKind === "REVERSAL" ? "reversal" : rawKind === "FEE" ? "fee" : "other";
      const eventCode = get("eventCode") || (suppliedKind === "receipt" ? "RECEIPT" : suppliedKind?.toUpperCase() ?? "UNMAPPED");
      const mappedKind = eventKind(eventCode);
      let kind = suppliedKind ?? mappedKind;
      let status = normalizeStatus(get("status"));
      if (suppliedKind && mappedKind !== "other" && suppliedKind !== mappedKind) throw new Error("The supplied payment kind contradicts the event type.");
      if (mappedKind === "other" || (kind === "receipt" && grossMinor <= 0)) { kind = "other"; status = "unsupported"; }
      const balanceImpact = normalizeEvent(get("balanceImpact"));
      const unknownImpact = balanceImpact !== "" && !["CREDIT", "DEBIT", "MEMO"].includes(balanceImpact);
      if (unknownImpact || balanceImpact === "MEMO" || (kind === "receipt" && balanceImpact === "DEBIT") || ((kind === "refund" || kind === "reversal") && balanceImpact === "CREDIT")) { kind = "other"; status = "unsupported"; }
      if ((kind === "refund" || kind === "reversal") && grossMinor >= 0) throw new Error("Refund and reversal gross amounts must be negative from the merchant perspective.");
      const parsedFee = optionalAmount(get("fee"));
      const netMinor = optionalAmount(get("net"));
      let feeMinor = parsedFee;
      if (parsedFee !== null && profile.feeMode === "bridge-verified") {
        if (netMinor === null && parsedFee !== 0) throw new Error("A nonzero PayPal Activity Fee needs Net to prove its sign. Supply Net or explicitly map a signed fee_cost column.");
        if (netMinor !== null) {
          const bridgeCost = safeSum([grossMinor, -netMinor]);
          if (parsedFee !== bridgeCost && parsedFee !== -bridgeCost) throw new Error("PayPal Activity Gross, Fee and Net do not form an exact bridge. Check the original amounts.");
          feeMinor = bridgeCost;
        }
      }
      if (feeMinor !== null && netMinor !== null && safeSum([grossMinor, -feeMinor]) !== netMinor) throw new Error("Gross minus fee cost does not equal net. Check the amount signs and import mapping.");
      const providerId = get("providerId");
      const referenceId = get("referenceId") || null;
      const type = get("referenceType").toUpperCase() || (referenceId && ["referencetxnid", "referencetransactionid", "relatedtransactionid"].includes(normalizeHeader(csv.headers[resolved.indexes.referenceId] ?? "")) ? "TXN" : null);
      const invoiceReferences = [...new Set(invoiceReferenceIndexes.map((index) => values[index]?.trim() ?? "").filter(Boolean))];
      if (invoiceReferences.length > 1) throw new Error("Invoice reference columns disagree. Map the intended invoice reference column before importing.");
      const parsed = paymentSchema.safeParse({ id: get("id") || providerId, providerId, eventCode, referenceId, referenceType: type, invoiceId: invoiceReferences[0] || null, customerKey: get("customerKey") || null, status, kind, grossMinor, feeMinor, netMinor, currency: get("currency"), timestamp: paymentDate(get("timestamp"), raw, activity), memo: get("memo"), sourceRow: row, raw });
      if (!parsed.success) { issues.push(...schemaIssues(row, parsed.error.issues)); return; }
      const payment = parsed.data;
      const key = observationKey(payment);
      const previous = observations.get(key);
      if (previous && observationValue(previous) === observationValue(payment)) { duplicateCount += 1; return; }
      if (previous) issues.push({ row, message: `Conflicting observation for provider ID ${providerId} and event ${eventCode}; first seen on row ${previous.sourceRow}. Neither observation can be applied until resolved.` });
      observations.set(key, payment);
      if (get("id")) explicitIds.add(payment);
      records.push(payment);
    } catch (error) {
      issues.push({ row, message: error instanceof Error ? error.message : "Invalid payment row." });
    }
  });
  const providerEvents = new Map<string, Set<string>>();
  records.forEach((payment) => {
    const events = providerEvents.get(payment.providerId) ?? new Set<string>();
    events.add(normalizeEvent(payment.eventCode));
    providerEvents.set(payment.providerId, events);
  });
  const ids = new Map<string, number>();
  const incomingProviders = new Map<string, Payment>();
  records.forEach((payment) => {
    if (!explicitIds.has(payment) && (providerEvents.get(payment.providerId)?.size ?? 0) > 1) payment.id = `${payment.providerId}:${normalizeEvent(payment.eventCode)}`;
    if (payment.id.length > 100) issues.push({ row: payment.sourceRow, message: "The composite row ID is too long; provide an explicit payment_id of at most 100 characters." });
    const previous = ids.get(payment.id);
    if (previous !== undefined) issues.push({ row: payment.sourceRow, message: `Record ID ${payment.id} also occurs on row ${previous}; conflicting observations require unique payment_id values.` });
    ids.set(payment.id, payment.sourceRow);
    if (isEligibleReceipt(payment)) {
      const incoming = incomingProviders.get(payment.providerId);
      if (incoming) issues.push({ row: payment.sourceRow, message: `Multiple incoming receipt observations share provider ID ${payment.providerId} (first row ${incoming.sourceRow}); do not count capture and reporting observations as separate receipts.` });
      incomingProviders.set(payment.providerId, payment);
    }
  });
  return { records, issues, duplicateCount };
}

export function isEligibleReceipt(payment: Pick<Payment, "status" | "kind" | "grossMinor" | "currency" | "eventCode">): boolean {
  return payment.currency === "USD" && payment.status === "completed" && payment.kind === "receipt" && Number.isSafeInteger(payment.grossMinor) && payment.grossMinor > 0 && payment.grossMinor <= MAX_MINOR && RECEIPT_EVENTS.has(normalizeEvent(payment.eventCode));
}

function paymentMatchesInvoice(payment: Payment, invoice: Invoice): boolean {
  return !reference(payment.invoiceId) || reference(payment.invoiceId) === reference(invoice.id);
}

function checkedAllocations(dataset: Dataset, review: ReviewState): Map<string, string> {
  const invoiceMap = new Map(dataset.invoices.map((invoice) => [invoice.id, invoice]));
  const paymentMap = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  if (invoiceMap.size !== dataset.invoices.length || paymentMap.size !== dataset.payments.length) throw new Error("Dataset record IDs must be unique before reconciling.");
  const observationKeys = new Set<string>();
  const receiptProviderIds = new Set<string>();
  for (const payment of dataset.payments) {
    const key = observationKey(payment);
    if (observationKeys.has(key)) throw new Error("Duplicate provider observations must be resolved before reconciling.");
    observationKeys.add(key);
    if (isEligibleReceipt(payment)) {
      if (receiptProviderIds.has(payment.providerId)) throw new Error("Multiple incoming observations of the same provider receipt cannot be reconciled as separate receipts.");
      receiptProviderIds.add(payment.providerId);
    }
  }
  const owners = new Map<string, string>();
  for (const allocation of review.allocations) {
    const invoice = invoiceMap.get(allocation.invoiceId);
    const payment = paymentMap.get(allocation.paymentId);
    if (!invoice || !payment || !isEligibleReceipt(payment) || !paymentMatchesInvoice(payment, invoice)) throw new Error("A review decision refers to missing, ineligible or conflicting evidence. Replace the review state before continuing.");
    const owner = owners.get(payment.id);
    if (owner && owner !== invoice.id) throw new Error("A receipt cannot be allocated to multiple invoices.");
    owners.set(payment.id, invoice.id);
  }
  return owners;
}

function addIndex(index: Map<string, Payment[]>, key: string, payment: Payment): void {
  if (!key) return;
  const values = index.get(key) ?? [];
  values.push(payment);
  index.set(key, values);
}

function isRefundEvidence(payment: Payment): boolean {
  return payment.kind === "refund" || payment.kind === "reversal" || ["refunded", "partially_refunded", "reversed"].includes(payment.status);
}

export function linkedAdjustment(payment: Payment, receipt: Payment): boolean {
  return isRefundEvidence(payment) && payment.referenceType === "TXN" && reference(payment.referenceId) === receipt.providerId;
}

export function reconcile(dataset: Dataset, review: ReviewState): Reconciliation {
  const owners = checkedAllocations(dataset, review);
  const rejected = new Map<string, Set<string>>();
  review.rejections.forEach((item) => {
    const ids = rejected.get(item.invoiceId) ?? new Set<string>();
    ids.add(item.paymentId);
    rejected.set(item.invoiceId, ids);
  });
  const byReference = new Map<string, Payment[]>();
  const byCustomer = new Map<string, Payment[]>();
  const byAmount = new Map<string, Payment[]>();
  const adjustmentsByReceipt = new Map<string, Payment[]>();
  dataset.payments.forEach((payment) => {
    addIndex(byReference, reference(payment.invoiceId), payment);
    if (isRefundEvidence(payment) && payment.referenceType === "TXN") addIndex(adjustmentsByReceipt, reference(payment.referenceId), payment);
    if (payment.kind === "receipt" || payment.status === "unsupported") {
      addIndex(byCustomer, customerKey(payment.customerKey), payment);
      addIndex(byAmount, String(payment.grossMinor), payment);
    }
  });
  byCustomer.forEach((payments) => payments.sort((a, b) => a.id.localeCompare(b.id)));
  const rows: InvoiceResult[] = dataset.invoices.map((invoice) => {
    const rejectedIds = rejected.get(invoice.id);
    const available = (payment: Payment) => paymentMatchesInvoice(payment, invoice) && (!owners.has(payment.id) || owners.get(payment.id) === invoice.id) && !rejectedIds?.has(payment.id);
    const referenced = (byReference.get(reference(invoice.id)) ?? []).filter(available);
    const customerPool = byCustomer.get(customerKey(invoice.customerKey)) ?? [];
    const customer = customerPool.filter((payment) => available(payment) && !reference(payment.invoiceId));
    const amount = (byAmount.get(String(invoice.amountMinor)) ?? []).filter((payment) => available(payment) && !reference(payment.invoiceId));
    const candidates = [...new Map([...referenced, ...customer, ...amount].map((payment) => [payment.id, payment])).values()];
    const candidatePayments: CandidatePayment[] = candidates.map((payment) => {
      const match: CandidatePayment["match"] = reference(payment.invoiceId) === reference(invoice.id) ? "reference" : customerKey(payment.customerKey) && customerKey(payment.customerKey) === customerKey(invoice.customerKey) ? "customer" : "amount";
      const reason = match === "reference" ? `Explicit invoice reference ${invoice.id}.` : match === "customer" ? payment.grossMinor === invoice.amountMinor ? "Customer identity and gross amount agree; no explicit invoice reference." : "Customer identity agrees; the gross amount differs and no explicit invoice reference was supplied." : "Gross amount agrees only; this is not proof of an association.";
      return { payment, match, reason, eligible: isEligibleReceipt(payment) };
    }).sort((a, b) => ({ reference: 0, customer: 1, amount: 2 }[a.match] - { reference: 0, customer: 1, amount: 2 }[b.match]) || Number(b.eligible) - Number(a.eligible) || a.payment.id.localeCompare(b.payment.id));
    const confirmedPayments = dataset.payments.filter((payment) => owners.get(payment.id) === invoice.id);
    const confirmedGrossMinor = safeSum(confirmedPayments.map((payment) => payment.grossMinor));
    const eligibleSuggestions = candidatePayments.filter((candidate) => candidate.eligible && !owners.has(candidate.payment.id));
    const directlyReferenced = eligibleSuggestions.filter((candidate) => candidate.match === "reference");
    const suggestedGrossMinor = directlyReferenced.length ? safeSum(directlyReferenced.map((candidate) => candidate.payment.grossMinor)) : eligibleSuggestions.length === 1 ? eligibleSuggestions[0].payment.grossMinor : 0;
    const associated = [...new Map([...referenced, ...confirmedPayments].map((payment) => [payment.id, payment])).values()];
    const refunds = [...new Map([...(byReference.get(invoice.id) ?? []).filter(isRefundEvidence), ...associated.flatMap((receipt) => adjustmentsByReceipt.get(receipt.providerId) ?? [])].map((payment) => [payment.id, payment])).values()];
    const hasRefund = refunds.length > 0 || associated.some(isRefundEvidence);
    const pending = associated.some((payment) => payment.kind === "receipt" && payment.status === "pending");
    const unsupported = referenced.some((payment) => payment.status === "unsupported" || payment.kind === "other");
    const reasons: string[] = [];
    if (candidatePayments.some((candidate) => candidate.match !== "reference")) reasons.push("Amount or customer similarity proposes a candidate only; manual confirmation is required.");
    if (eligibleSuggestions.length > 1 && !directlyReferenced.length) reasons.push("Multiple candidate receipts remain ambiguous; their amounts are not combined into suggested coverage.");
    if (hasRefund) reasons.push(`Refund or reversal evidence prevents a simple settled conclusion${refunds.length ? `: ${refunds.map((payment) => payment.id).join(", ")}` : "."}`);
    if (pending) reasons.push("Pending receipts do not contribute to settled gross.");
    if (unsupported) reasons.push("Unsupported referenced events require review and do not contribute to settled gross.");
    if (!confirmedPayments.length) reasons.push("No receipt is confirmed for this invoice in the loaded data; this does not prove it is unpaid.");
    const unknownFeeCount = confirmedPayments.filter((payment) => payment.feeMinor === null).length;
    if (unknownFeeCount) reasons.push(`${unknownFeeCount} confirmed receipt fee value${unknownFeeCount === 1 ? " is" : "s are"} unknown.`);
    const status: InvoiceResult["status"] = hasRefund ? "refund" : unsupported ? "needs-review" : confirmedGrossMinor > invoice.amountMinor ? "overpaid" : confirmedGrossMinor === invoice.amountMinor ? pending ? "needs-review" : "covered" : confirmedGrossMinor > 0 ? "partial" : pending ? "pending" : eligibleSuggestions.length ? "needs-review" : "unmatched";
    return { invoice, candidatePayments, confirmedPayments, confirmedGrossMinor, suggestedGrossMinor, knownFeeMinor: safeSum(confirmedPayments.flatMap((payment) => payment.feeMinor === null ? [] : [payment.feeMinor])), unknownFeeCount, status, reasons };
  });
  return {
    rows,
    unallocatedPayments: dataset.payments.filter((payment) => isEligibleReceipt(payment) && !owners.has(payment.id)),
    stats: {
      invoiceCount: rows.length,
      needsReviewCount: rows.filter((row) => row.status !== "covered").length,
      coveredCount: rows.filter((row) => row.status === "covered").length,
      confirmedGrossMinor: safeSum(rows.map((row) => row.confirmedGrossMinor)),
      totalInvoiceMinor: safeSum(rows.map((row) => row.invoice.amountMinor)),
      knownFeeMinor: safeSum(rows.map((row) => row.knownFeeMinor)),
      unknownFeeCount: safeSum(rows.map((row) => row.unknownFeeCount)),
    },
  };
}

export function confirmAllocation(dataset: Dataset, review: ReviewState, invoiceId: string, paymentIds: string[], reason = "Confirmed after reviewing source evidence."): ReviewState {
  const invoice = dataset.invoices.find((item) => item.id === invoiceId);
  if (!invoice) throw new Error("The selected invoice is no longer available.");
  if (!paymentIds.length || new Set(paymentIds).size !== paymentIds.length) throw new Error("Select one or more distinct receipts to confirm.");
  const owners = checkedAllocations(dataset, review);
  const selected = paymentIds.map((id) => {
    const payment = dataset.payments.find((item) => item.id === id);
    if (!payment || !isEligibleReceipt(payment)) throw new Error("Only supported, completed incoming receipts can be allocated.");
    if (!paymentMatchesInvoice(payment, invoice)) throw new Error(`Receipt ${payment.id} explicitly references another invoice.`);
    if (owners.has(id) && owners.get(id) !== invoiceId) throw new Error(`Receipt ${id} has already been confirmed for another invoice.`);
    return payment;
  });
  const existing = dataset.payments.filter((payment) => owners.get(payment.id) === invoiceId);
  const combined = [...new Map([...existing, ...selected].map((payment) => [payment.id, payment])).values()];
  safeSum(combined.map((payment) => payment.grossMinor));
  const newPayments = selected.filter((payment) => !owners.has(payment.id));
  if (!newPayments.length) return review;
  const confirmedAt = new Date().toISOString();
  const revision = review.revision + 1;
  const selectedIds = new Set(paymentIds);
  return { allocations: [...review.allocations, ...newPayments.map((payment) => ({ invoiceId, paymentId: payment.id, reason: reason.trim().slice(0, 4096) || "Confirmed after reviewing source evidence.", confirmedAt, datasetRevision: dataset.revision, reviewRevision: revision }))], rejections: review.rejections.filter((item) => item.invoiceId !== invoiceId || !selectedIds.has(item.paymentId)), revision };
}

export function rejectAllocation(dataset: Dataset, review: ReviewState, invoiceId: string, paymentId: string, reason = "Rejected after reviewing source evidence."): ReviewState {
  if (!dataset.invoices.some((invoice) => invoice.id === invoiceId) || !dataset.payments.some((payment) => payment.id === paymentId)) throw new Error("The selected association is no longer available.");
  if (review.allocations.some((item) => item.invoiceId === invoiceId && item.paymentId === paymentId)) throw new Error("Undo the confirmed allocation before rejecting it.");
  if (review.rejections.some((item) => item.invoiceId === invoiceId && item.paymentId === paymentId)) return review;
  const revision = review.revision + 1;
  return { allocations: [...review.allocations], rejections: [...review.rejections, { invoiceId, paymentId, reason: reason.trim().slice(0, 4096) || "Rejected after reviewing source evidence.", rejectedAt: new Date().toISOString(), datasetRevision: dataset.revision, reviewRevision: revision }], revision };
}

export function undoInvoiceReview(review: ReviewState, invoiceId: string): ReviewState {
  const allocations = review.allocations.filter((item) => item.invoiceId !== invoiceId);
  const rejections = review.rejections.filter((item) => item.invoiceId !== invoiceId);
  return allocations.length === review.allocations.length && rejections.length === review.rejections.length ? review : { allocations, rejections, revision: review.revision + 1 };
}

function safeText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function exportReconciliation(dataset: Dataset, review: ReviewState): string {
  const result = reconcile(dataset, review);
  type ExportRow = Record<string, string | number>;
  const source = (value: Dataset["paymentSource"], prefix = ""): ExportRow => Object.fromEntries(Object.entries({
    source_kind: safeText(value?.kind ?? "unknown"),
    source_label: safeText(value?.label ?? "Unverified source"),
    coverage: value?.coverage ?? "unknown",
    range_start: safeText(value?.rangeStart ?? ""),
    range_end: safeText(value?.rangeEnd ?? ""),
    requested_range_start: safeText(value?.requestedRangeStart ?? ""),
    requested_range_end: safeText(value?.requestedRangeEnd ?? ""),
    filters: value?.filters === undefined ? "" : safeText(JSON.stringify(value.filters)),
    account_identity_kind: value?.accountIdentity?.kind ?? "",
    account_identity_value: safeText(value?.accountIdentity?.value ?? ""),
    fetched_at: safeText(value?.fetchedAt ?? ""),
    provider_verified: value?.providerVerified ? "true" : "false",
    unsupported_count: value?.unsupportedCount ?? 0,
    duplicate_count: value?.duplicateCount ?? 0,
  }).map(([key, value]) => [`${prefix}${key}`, value]));
  const session = {
    current_dataset_revision: dataset.revision,
    current_review_revision: review.revision,
    session_note: "Current tab review; not a durable audit log or complete account ledger.",
  };
  const invoiceRows: ExportRow[] = result.rows.map((row) => ({
    record_type: "invoice",
    invoice_id: safeText(row.invoice.id),
    customer: safeText(row.invoice.customer),
    invoice_description: safeText(row.invoice.description ?? ""),
    currency: "USD",
    invoice_amount: decimalMoney(row.invoice.amountMinor),
    confirmed_gross: decimalMoney(row.confirmedGrossMinor),
    suggested_gross: decimalMoney(row.suggestedGrossMinor),
    confirmed_fee_cost_known: decimalMoney(row.knownFeeMinor),
    unknown_fee_count: row.unknownFeeCount,
    status: row.status,
    confirmed_payment_ids: safeText(row.confirmedPayments.map((payment) => payment.id).join(" | ")),
    suggested_payment_ids: safeText(row.candidatePayments.filter((candidate) => candidate.eligible && !row.confirmedPayments.some((payment) => payment.id === candidate.payment.id)).map((candidate) => candidate.payment.id).join(" | ")),
    decision_reasons: safeText(review.allocations.filter((item) => item.invoiceId === row.invoice.id).map((item) => `${item.paymentId}: ${item.reason}`).join(" | ")),
    rejected_payment_ids: safeText(review.rejections.filter((item) => item.invoiceId === row.invoice.id).map((item) => item.paymentId).join(" | ")),
    exceptions: safeText(row.reasons.join(" | ")),
    invoice_source_row: row.invoice.sourceRow,
    ...source(dataset.invoiceSource, "invoice_"),
    ...source(dataset.paymentSource),
    ...session,
  }));
  const paymentRows: ExportRow[] = dataset.payments.map((payment) => ({
    record_type: "payment",
    invoice_id: safeText(payment.invoiceId ?? ""),
    currency: payment.currency,
    payment_id: safeText(payment.id),
    provider_id: safeText(payment.providerId),
    event_code: safeText(payment.eventCode),
    payment_kind: payment.kind,
    status: payment.status,
    gross: decimalMoney(payment.grossMinor),
    fee_cost: decimalMoney(payment.feeMinor),
    net: decimalMoney(payment.netMinor),
    reference_id: safeText(payment.referenceId ?? ""),
    reference_type: payment.referenceType ?? "",
    payment_source_row: payment.sourceRow,
    confirmed_for_invoice: safeText(review.allocations.find((item) => item.paymentId === payment.id)?.invoiceId ?? ""),
    ...source(dataset.paymentSource),
    ...session,
  }));
  const decisionRows: ExportRow[] = [
    ...review.allocations.map((decision) => ({
      record_type: "decision", action: "confirm", invoice_id: safeText(decision.invoiceId), payment_id: safeText(decision.paymentId), reason: safeText(decision.reason), decided_at: safeText(decision.confirmedAt), dataset_revision: decision.datasetRevision, review_revision: decision.reviewRevision, ...source(dataset.invoiceSource, "invoice_"), ...source(dataset.paymentSource), ...session,
    })),
    ...review.rejections.map((decision) => ({
      record_type: "decision", action: "reject", invoice_id: safeText(decision.invoiceId), payment_id: safeText(decision.paymentId), reason: safeText(decision.reason), decided_at: safeText(decision.rejectedAt), dataset_revision: decision.datasetRevision, review_revision: decision.reviewRevision, ...source(dataset.invoiceSource, "invoice_"), ...source(dataset.paymentSource), ...session,
    })),
  ];
  const records = [...invoiceRows, ...paymentRows, ...decisionRows];
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))];
  if (!records.length) return Papa.unparse({ fields: ["record_type", "invoice_id", "payment_id", "status", "session_note"], data: [] });
  return Papa.unparse({ fields, data: records.map((record) => fields.map((field) => record[field] ?? "")) }, { newline: "\r\n" });
}

type InvestigationContext = Pick<InvestigationRequest, "caseId" | "excerptPaymentId" | "invoices" | "payments" | "invoiceScope">;

function investigationContext(dataset: Dataset, review: ReviewState, caseId: string, paymentId: string | undefined, invoiceContexts: Record<string, string>, invoiceScopeIds?: string[]): InvestigationContext {
  const reconciliation = reconcile(dataset, review);
  const selected = reconciliation.rows.find((row) => row.invoice.id === caseId);
  if (!selected) throw new Error("Select an invoice before investigating.");
  const directPayments = [...new Map([...selected.confirmedPayments, ...selected.candidatePayments.map((candidate) => candidate.payment)].map((payment) => [payment.id, payment])).values()];
  if (!directPayments.length) throw new Error("No receipt evidence is available for this invoice.");
  const receiptOptions = directPayments.filter((payment) => payment.kind === "receipt");
  const owner = paymentId ? receiptOptions.find((payment) => payment.id === paymentId) : receiptOptions.length === 1 ? receiptOptions[0] : undefined;
  if (!owner) throw new Error(paymentId ? "The selected excerpt receipt is not available for this case." : "Select the receipt that owns the remittance excerpt before investigating.");
  const adjustments = dataset.payments.filter((payment) => linkedAdjustment(payment, owner));
  const payments = [owner, ...adjustments.filter((payment) => payment.id !== owner.id)];
  const allInvoiceRows = [selected, ...reconciliation.rows.filter((row) => row.invoice.id !== caseId && row.candidatePayments.some((candidate) => candidate.payment.id === owner.id))];
  if (invoiceScopeIds && (invoiceScopeIds.length === 0 || invoiceScopeIds.length > 20 || new Set(invoiceScopeIds).size !== invoiceScopeIds.length || !invoiceScopeIds.includes(caseId))) throw new Error("Choose 1–20 distinct invoice candidates and include the current invoice in the investigation scope.");
  const relatedIds = new Set(allInvoiceRows.map((row) => row.invoice.id));
  if (invoiceScopeIds?.some((id) => !relatedIds.has(id))) throw new Error("The investigation scope contains an invoice that is not a current candidate for this receipt.");
  const scopedIds = invoiceScopeIds ? new Set(invoiceScopeIds) : null;
  const invoiceRows = scopedIds ? allInvoiceRows.filter((row) => scopedIds.has(row.invoice.id)) : allInvoiceRows;
  if (invoiceRows.length > 20) throw new Error(`This receipt has ${invoiceRows.length} related invoice candidates; AI investigations support at most 20. Select a temporary investigation scope without rejecting the other associations. No model request was sent.`);
  if (payments.length > 20) throw new Error(`This receipt has ${payments.length - 1} linked adjustments (${payments.length} payment records total); AI investigations support at most 20 payment records. Narrow the loaded records or review this case manually. No model request was sent.`);
  const groups = new Map<string, string>();
  const group = (key: string | null) => {
    const normalized = customerKey(key);
    if (!normalized) return null;
    if (!groups.has(normalized)) groups.set(normalized, `group-${groups.size + 1}`);
    return groups.get(normalized) ?? null;
  };
  return {
    caseId,
    excerptPaymentId: owner.id,
    invoices: invoiceRows.map(({ invoice }) => evidenceInvoiceSchema.parse({ id: invoice.id, amountMinor: invoice.amountMinor, currency: invoice.currency, dueDate: invoice.dueDate, customerGroup: group(invoice.customerKey), context: Object.hasOwn(invoiceContexts, invoice.id) ? invoiceContexts[invoice.id] : "" })),
    payments: payments.map((payment) => ({ id: payment.id, grossMinor: payment.grossMinor, feeMinor: payment.feeMinor, netMinor: payment.netMinor, currency: payment.currency, invoiceId: payment.invoiceId, status: payment.status, kind: payment.kind, eventCode: payment.eventCode, customerGroup: group(payment.customerKey) })),
    ...(invoiceRows.length < allInvoiceRows.length ? { invoiceScope: { totalCandidates: allInvoiceRows.length, excludedCandidates: allInvoiceRows.length - invoiceRows.length } } : {}),
  };
}

function fingerprintForContext(dataset: Dataset, review: ReviewState, context: InvestigationContext, excerpt: string): string {
  const paymentIds = new Set(context.payments.map((payment) => payment.id));
  const invoiceIds = new Set(context.invoices.map((invoice) => invoice.id));
  const fingerprint = JSON.stringify({ datasetRevision: dataset.revision, reviewRevision: review.revision, ...context, allocations: review.allocations.filter((item) => paymentIds.has(item.paymentId) || invoiceIds.has(item.invoiceId)).map(({ invoiceId, paymentId }) => ({ invoiceId, paymentId })), rejections: review.rejections.filter((item) => paymentIds.has(item.paymentId) && invoiceIds.has(item.invoiceId)).map(({ invoiceId, paymentId }) => ({ invoiceId, paymentId })), excerpt: excerpt.trim() });
  if (fingerprint.length > 32768) throw new Error("This case has too much evidence for a bounded investigation. Narrow the receipt selection.");
  return fingerprint;
}

export function caseFingerprint(dataset: Dataset, review: ReviewState, caseId: string, excerpt: string, paymentId?: string, invoiceContexts: Record<string, string> = {}, invoiceScopeIds?: string[]): string {
  return fingerprintForContext(dataset, review, investigationContext(dataset, review, caseId, paymentId, invoiceContexts, invoiceScopeIds), excerpt);
}

export function buildInvestigationRequest(dataset: Dataset, review: ReviewState, caseId: string, excerpt: string, requestId: string, paymentId?: string, invoiceContexts: Record<string, string> = {}, invoiceScopeIds?: string[]): InvestigationRequest {
  const context = investigationContext(dataset, review, caseId, paymentId, invoiceContexts, invoiceScopeIds);
  return investigationRequestSchema.parse({ ...context, excerpt: excerpt.trim(), requestId, fingerprint: fingerprintForContext(dataset, review, context, excerpt) });
}

export function buildObservations(request: Pick<InvestigationRequest, "invoices" | "payments">): Observation[] {
  const observations: Observation[] = [];
  for (const invoice of request.invoices) {
    if (!Number.isSafeInteger(invoice.amountMinor) || invoice.amountMinor <= 0 || invoice.amountMinor > MAX_MINOR) throw new Error("Invoice evidence has an invalid amount.");
    observations.push({ id: `invoice:${invoice.id}:amount`, text: `${invoice.id} has an invoice amount of ${formatMoney(invoice.amountMinor)} USD.`, evidenceIds: [`invoice:${invoice.id}`] });
  }
  for (const payment of request.payments) {
    for (const amount of [payment.grossMinor, payment.feeMinor, payment.netMinor]) if (amount !== null && (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_MINOR)) throw new Error("Payment evidence has an invalid amount.");
    const evidenceIds = [`payment:${payment.id}`];
    observations.push({ id: `payment:${payment.id}:gross`, text: `${payment.id} has gross ${formatMoney(payment.grossMinor)} USD.`, evidenceIds });
    observations.push({ id: `payment:${payment.id}:fee`, text: payment.feeMinor === null ? `${payment.id} has an unknown fee cost; zero is not assumed.` : `${payment.id} has fee cost ${formatMoney(payment.feeMinor)} USD.`, evidenceIds });
    observations.push({ id: `payment:${payment.id}:net`, text: payment.netMinor === null ? `${payment.id} has an unknown net receipt; no net amount is inferred.` : `${payment.id} has net ${formatMoney(payment.netMinor)} USD.`, evidenceIds });
    observations.push({ id: `payment:${payment.id}:status`, text: `${payment.id} is ${payment.status}; its event is ${payment.eventCode} and kind is ${payment.kind}.`, evidenceIds });
    observations.push({ id: `payment:${payment.id}:reference`, text: payment.invoiceId ? `${payment.id} supplies invoice reference ${payment.invoiceId}.` : `${payment.id} has no supplied invoice reference.`, evidenceIds });
    observations.push({ id: `payment:${payment.id}:eligibility`, text: isEligibleReceipt(payment) ? `${payment.id} is an eligible incoming receipt, subject to relationship and allocation review.` : `${payment.id} is not an eligible settled incoming receipt and cannot establish invoice coverage.`, evidenceIds });
    if (payment.feeMinor !== null && payment.netMinor !== null) {
      if (safeSum([payment.grossMinor, -payment.feeMinor]) !== payment.netMinor) throw new Error("Payment evidence contains contradictory gross, fee and net values.");
      observations.push({ id: `payment:${payment.id}:bridge`, text: `${payment.id}: gross ${formatMoney(payment.grossMinor)} minus fee cost ${formatMoney(payment.feeMinor)} equals net ${formatMoney(payment.netMinor)} USD. Fees do not reduce invoice gross coverage.`, evidenceIds });
    }
  }
  return observations;
}
