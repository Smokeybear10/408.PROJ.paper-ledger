import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_MINOR, MAX_ROWS, paymentSchema, paypalApiRequestSchema, paypalConnectionRequestSchema, paypalConnectionStatusSchema, paypalResponseSchema, type Payment, type PayPalConnectionRequest, type PayPalConnectionStatus, type PayPalRequest } from "@/lib/contracts";
import { isEligibleReceipt } from "@/lib/reconciliation";
import { ApiFailure, apiError, apiJson, fetchProviderJson, readLocalRequest } from "@/lib/server-boundary";

export const runtime = "nodejs";

const PAYPAL_HOST = "https://api-m.sandbox.paypal.com";
const dateTimeSchema = z.iso.datetime({ offset: true });
const moneySchema = z.object({ currency_code: z.string().length(3), value: z.string().min(1).max(32) });
const providerIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const accountIdentityValueSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9]+$/);
const tokenSchema = z.object({ access_token: z.string().min(1).max(8192), token_type: z.literal("Bearer"), expires_in: z.number().int().positive().max(604800) });
const transactionInfoSchema = z.object({
  transaction_id: providerIdSchema,
  transaction_event_code: z.string().regex(/^T\d{4}$/),
  transaction_status: z.string().min(1).max(32),
  transaction_amount: moneySchema,
  fee_amount: moneySchema.optional(),
  transaction_initiation_date: dateTimeSchema,
  paypal_reference_id: providerIdSchema.optional(),
  paypal_reference_id_type: z.enum(["TXN", "ODR", "SUB", "PAP"]).optional(),
  invoice_id: z.string().max(100).optional(),
  transaction_note: z.string().max(4096).optional(),
  transaction_subject: z.string().max(4096).optional(),
});
const transactionSchema = z.object({
  transaction_info: transactionInfoSchema,
  payer_info: z.object({ account_id: z.string().max(240).optional(), email_address: z.string().max(240).optional() }).optional(),
});
const reportSchema = z.object({
  transaction_details: z.array(z.unknown()).max(500),
  total_items: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  account_number: accountIdentityValueSchema.optional(),
  start_date: dateTimeSchema,
  end_date: dateTimeSchema,
});
const captureSchema = z.object({
  id: providerIdSchema,
  status: z.string().min(1).max(32),
  amount: moneySchema,
  seller_receivable_breakdown: z.object({ gross_amount: moneySchema.optional(), paypal_fee: moneySchema.optional(), net_amount: moneySchema.optional() }).optional(),
  invoice_id: z.string().max(100).optional(),
  create_time: dateTimeSchema,
  supplementary_data: z.object({ related_ids: z.object({ order_id: providerIdSchema.optional() }).optional() }).optional(),
  payee: z.object({ merchant_id: accountIdentityValueSchema.optional() }).optional(),
});

type SandboxToken = { value: string; expiresAt: number };
type SandboxConnection = {
  id: string;
  clientId: string;
  clientSecret: string;
  source: "environment" | "memory";
  authenticated: boolean;
  token: SandboxToken | null;
  pendingToken: Promise<string> | null;
  controller: AbortController;
};
type ConnectionAttempt = { controller: AbortController };
type SandboxStore = { version: 1; connection: SandboxConnection | null; attempt: ConnectionAttempt | null };
const processState = globalThis as typeof globalThis & { __paperLedgerPayPalSession_v1?: SandboxStore };

function newConnection(clientId: string, clientSecret: string, source: SandboxConnection["source"]): SandboxConnection {
  return { id: randomUUID(), clientId, clientSecret, source, authenticated: false, token: null, pendingToken: null, controller: new AbortController() };
}

function sessionStore(): SandboxStore {
  if (!processState.__paperLedgerPayPalSession_v1) {
    const credentials = paypalConnectionRequestSchema.safeParse({ operation: "connect", clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET });
    const connection = credentials.success && credentials.data.operation === "connect" ? newConnection(credentials.data.clientId, credentials.data.clientSecret, "environment") : null;
    processState.__paperLedgerPayPalSession_v1 = { version: 1, connection, attempt: null };
  }
  return processState.__paperLedgerPayPalSession_v1;
}

function connectionStatus(): PayPalConnectionStatus {
  const connection = sessionStore().connection;
  return paypalConnectionStatusSchema.parse({ connected: connection !== null, authenticated: connection?.authenticated ?? false, source: connection?.source ?? null, connectionId: connection?.id ?? null });
}

function connectionChanged(): ApiFailure {
  return new ApiFailure(409, "paypal_connection_changed", "The sandbox connection changed. Fetch its current status and request a new preview.");
}

function assertCurrent(connection: SandboxConnection): void {
  if (sessionStore().connection !== connection || connection.controller.signal.aborted) throw connectionChanged();
}

function selectedConnection(connectionId: string): SandboxConnection {
  const connection = sessionStore().connection;
  if (!connection) throw new ApiFailure(503, "paypal_not_configured", "Connect your sandbox app with its client ID and secret. Your current records have been kept.");
  if (connection.id !== connectionId) throw connectionChanged();
  assertCurrent(connection);
  return connection;
}

function retireConnection(connection: SandboxConnection | null): void {
  if (!connection) return;
  connection.controller.abort();
  connection.clientId = "";
  connection.clientSecret = "";
  connection.token = null;
  connection.pendingToken = null;
  connection.authenticated = false;
}

function disconnect(): PayPalConnectionStatus {
  const store = sessionStore();
  store.attempt?.controller.abort();
  store.attempt = null;
  const previous = store.connection;
  store.connection = null;
  retireConnection(previous);
  return connectionStatus();
}

function providerData<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiFailure(502, "invalid_paypal_response", "PayPal returned unsupported or incomplete data. The current dataset has not been replaced.");
  return parsed.data;
}

function parseMoney(amount: z.infer<typeof moneySchema>): number {
  if (amount.currency_code !== "USD") throw new ApiFailure(422, "unsupported_currency", "This prototype supports USD only. The current dataset has not been replaced.");
  const parts = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (!parts) throw new ApiFailure(502, "invalid_paypal_amount", "PayPal returned an unsupported amount. The current dataset has not been replaced.");
  const minor = (BigInt(parts[2]) * 100n + BigInt((parts[3] ?? "").padEnd(2, "0"))) * (parts[1] ? -1n : 1n);
  if (minor > BigInt(MAX_MINOR) || minor < -BigInt(MAX_MINOR)) throw new ApiFailure(422, "amount_limit", "A PayPal amount exceeds the supported record limit.");
  const value = Number(minor);
  if (!Number.isSafeInteger(value)) throw new ApiFailure(502, "invalid_paypal_amount", "PayPal returned an unsupported amount.");
  return value;
}

function checkComponents(gross: number, fee: number | null, net: number | null): void {
  if (fee !== null && net !== null && (!Number.isSafeInteger(gross - fee) || gross - fee !== net)) {
    throw new ApiFailure(502, "conflicting_paypal_amounts", "PayPal returned contradictory gross, fee and net amounts. The current dataset has not been replaced.");
  }
}

async function requestToken(connection: SandboxConnection, signal: AbortSignal): Promise<SandboxToken> {
  const response = await fetchProviderJson(`${PAYPAL_HOST}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${connection.clientId}:${connection.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "grant_type=client_credentials",
    signal,
  }, 15_000, 32 * 1024);
  if (response.status === 401 || response.status === 403) throw new ApiFailure(502, "paypal_authentication_failed", "PayPal rejected the sandbox app credentials. Check its client ID and secret.");
  if (response.status < 200 || response.status >= 300) throw new ApiFailure(502, "paypal_authentication_failed", "PayPal could not issue a sandbox access token. Try again.");
  const result = providerData(tokenSchema, response.data);
  return { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 30) * 1000 };
}

async function connect(input: Extract<PayPalConnectionRequest, { operation: "connect" }>, signal: AbortSignal): Promise<PayPalConnectionStatus> {
  const store = sessionStore();
  store.attempt?.controller.abort();
  const attempt = { controller: new AbortController() };
  store.attempt = attempt;
  const candidate = newConnection(input.clientId, input.clientSecret, "memory");
  try {
    const combinedSignal = AbortSignal.any([signal, attempt.controller.signal, candidate.controller.signal]);
    const result = await requestToken(candidate, combinedSignal);
    if (store.attempt !== attempt) throw connectionChanged();
    if (combinedSignal.aborted) throw new ApiFailure(499, "request_cancelled", "The sandbox connection request was cancelled.");
    candidate.token = result;
    candidate.authenticated = true;
    const previous = store.connection;
    store.connection = candidate;
    retireConnection(previous);
    return connectionStatus();
  } catch (error) {
    if (store.attempt !== attempt) throw connectionChanged();
    throw error;
  } finally {
    if (store.attempt === attempt) store.attempt = null;
    if (store.connection !== candidate) retireConnection(candidate);
  }
}

async function token(connection: SandboxConnection, forceRefresh = false): Promise<string> {
  assertCurrent(connection);
  if (!forceRefresh && connection.token && connection.token.expiresAt > Date.now()) return connection.token.value;
  if (connection.pendingToken) return connection.pendingToken;
  const promise = (async () => {
    try {
      const result = await requestToken(connection, connection.controller.signal);
      assertCurrent(connection);
      connection.token = result;
      connection.authenticated = true;
      return result.value;
    } catch (error) {
      assertCurrent(connection);
      if (error instanceof ApiFailure && error.code === "paypal_authentication_failed") connection.authenticated = false;
      throw error;
    }
  })();
  connection.pendingToken = promise;
  try {
    return await promise;
  } finally {
    if (connection.pendingToken === promise) connection.pendingToken = null;
  }
}

async function paypalGet(connection: SandboxConnection, path: string, signal: AbortSignal): Promise<unknown> {
  try {
    let accessToken = await token(connection);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertCurrent(connection);
      const response = await fetchProviderJson(`${PAYPAL_HOST}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "PayPal-Enforce-ISO8601-Format": "true" }, signal: AbortSignal.any([signal, connection.controller.signal]) }, 20_000);
      assertCurrent(connection);
      if (response.status === 401 && attempt === 0) {
        if (connection.token?.value === accessToken) connection.token = null;
        accessToken = await token(connection, true);
        continue;
      }
      if (response.status === 401) {
        connection.authenticated = false;
        throw new ApiFailure(502, "paypal_authentication_failed", "PayPal rejected the refreshed access token. Check the sandbox app credentials.");
      }
      if (response.status === 403) throw new ApiFailure(502, "paypal_permission_denied", "The sandbox app does not have access to this record or reporting operation. Check its merchant and reporting permissions.");
      if (response.status === 404) throw new ApiFailure(404, "paypal_record_not_found", "That capture was not found for this sandbox merchant.");
      if (response.status === 429) throw new ApiFailure(429, "paypal_rate_limited", "PayPal is limiting requests. Wait briefly and try again.");
      if (response.status < 200 || response.status >= 300) throw new ApiFailure(502, "paypal_request_failed", "PayPal could not complete this sandbox request. Check the requested dates or capture ID and try again.");
      return response.data;
    }
    throw new ApiFailure(502, "paypal_authentication_failed", "PayPal authentication failed.");
  } catch (error) {
    assertCurrent(connection);
    throw error;
  }
}

function capturePayment(capture: z.infer<typeof captureSchema>, captureId: string): Payment {
  if (capture.id !== captureId) throw new ApiFailure(502, "paypal_record_mismatch", "PayPal returned a different capture ID. The current dataset has not been replaced.");
  const grossMinor = parseMoney(capture.amount);
  const breakdown = capture.seller_receivable_breakdown;
  if (breakdown?.gross_amount && parseMoney(breakdown.gross_amount) !== grossMinor) throw new ApiFailure(502, "conflicting_paypal_amounts", "PayPal returned contradictory capture amounts.");
  const feeMinor = breakdown?.paypal_fee ? parseMoney(breakdown.paypal_fee) : null;
  const netMinor = breakdown?.net_amount ? parseMoney(breakdown.net_amount) : null;
  checkComponents(grossMinor, feeMinor, netMinor);
  const statuses: Record<string, Payment["status"]> = { COMPLETED: "completed", PENDING: "pending", REFUNDED: "refunded", PARTIALLY_REFUNDED: "partially_refunded", DECLINED: "failed", FAILED: "failed", REVERSED: "reversed" };
  const status = statuses[capture.status] ?? "unsupported";
  const orderId = capture.supplementary_data?.related_ids?.order_id ?? null;
  return providerData(paymentSchema, {
    id: `${capture.id}:CAPTURE`, providerId: capture.id, eventCode: "CAPTURE", referenceId: orderId, referenceType: orderId ? "ODR" : null,
    invoiceId: capture.invoice_id?.trim() || null, customerKey: null, status: grossMinor > 0 ? status : "unsupported", kind: "receipt", grossMinor, feeMinor, netMinor, currency: "USD", timestamp: capture.create_time,
    memo: "", sourceRow: 1,
    raw: { gross: capture.amount.value, fee: breakdown?.paypal_fee?.value ?? "", net: breakdown?.net_amount?.value ?? "", status: capture.status, mapping: "capture: merchant gross/net; paypal_fee is signed fee cost", ...(status === "refunded" || status === "partially_refunded" ? { refundAmount: "unknown; capture status is an exception, not a refund amount" } : {}) },
  });
}

function reportPayment(data: unknown, row: number): Payment {
  const record = providerData(transactionSchema, data);
  const info = record.transaction_info;
  const grossMinor = parseMoney(info.transaction_amount);
  const feeMinor = info.fee_amount ? -parseMoney(info.fee_amount) : null;
  const event = info.transaction_event_code;
  const statuses: Record<string, Payment["status"]> = { S: "completed", P: "pending", D: "failed", V: "reversed" };
  let status: Payment["status"] = statuses[info.transaction_status] ?? "unsupported";
  let kind: Payment["kind"] = "other";
  if (info.transaction_status === "V") kind = "reversal";
  else if (["T0000", "T0006"].includes(event) && grossMinor > 0) kind = "receipt";
  else if (["T1107", "T1115", "T1120"].includes(event)) {
    kind = "refund";
    if (info.transaction_status === "S") status = "refunded";
  } else if (["T1100", "T1106", "T1114", "T1116", "T1118", "T1119", "T1201", "T1202", "T1205", "T1207", "T1208"].includes(event)) {
    kind = "reversal";
    if (info.transaction_status === "S") status = "reversed";
  } else if (["T0100", "T0106", "T0107", "T1108", "T1109"].includes(event)) kind = "fee";
  if (kind === "other" || kind === "fee") status = "unsupported";
  const payer = record.payer_info;
  return providerData(paymentSchema, {
    id: `${info.transaction_id}:${event}:Y`, providerId: info.transaction_id, eventCode: event, referenceId: info.paypal_reference_id ?? null, referenceType: info.paypal_reference_id_type ?? null,
    invoiceId: info.invoice_id?.trim() || null, customerKey: payer?.email_address?.trim().toLowerCase() || payer?.account_id?.trim() || null,
    status, kind, grossMinor, feeMinor, netMinor: null, currency: "USD", timestamp: info.transaction_initiation_date, memo: info.transaction_note ?? info.transaction_subject ?? "", sourceRow: row,
    raw: { gross: info.transaction_amount.value, fee: info.fee_amount?.value ?? "", net: "", status: info.transaction_status, balanceAffecting: "Y", mapping: "reporting: merchant signed gross; fee cost = negative of fee_amount; net not supplied" },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function reporting(connection: SandboxConnection, request: Extract<PayPalRequest, { operation: "transactions" }>, signal: AbortSignal) {
  const start = dateTimeSchema.safeParse(request.startDate);
  const end = dateTimeSchema.safeParse(request.endDate);
  if (!start.success || !end.success) throw new ApiFailure(400, "invalid_date_range", "Use RFC3339 dates with seconds and a timezone for the reporting window.");
  const startMs = Date.parse(start.data);
  const endMs = Date.parse(end.data);
  if (endMs <= startMs || endMs - startMs > 31 * 24 * 60 * 60 * 1000) throw new ApiFailure(400, "invalid_date_range", "Choose a start before the end, within a maximum 31-day window.");
  const payments: Payment[] = [];
  const fingerprints = new Map<string, string>();
  const incomingProviderIds = new Set<string>();
  let duplicateCount = 0;
  let rawCount = 0;
  let expectedItems: number | null = null;
  let expectedPages: number | null = null;
  let account: string | undefined;
  let returnedStart = "";
  let returnedEnd = "";
  let page = 1;
  do {
    const query = new URLSearchParams({ start_date: start.data, end_date: end.data, fields: "all", balance_affecting_records_only: "Y", page_size: "500", page: String(page) });
    const result = providerData(reportSchema, await paypalGet(connection, `/v1/reporting/transactions?${query}`, signal));
    if (result.total_items > MAX_ROWS || result.total_pages > 2) throw new ApiFailure(422, "reporting_row_limit", "The reporting result exceeds 1,000 records. Reduce the date range and try again.");
    const validPageCount = result.total_items === 0 ? result.total_pages === 0 || result.total_pages === 1 : result.total_pages === Math.ceil(result.total_items / 500);
    const expectedLength = Math.min(500, Math.max(0, result.total_items - (page - 1) * 500));
    if (!validPageCount || result.transaction_details.length !== expectedLength) throw new ApiFailure(502, "inconsistent_paypal_pages", "PayPal returned inconsistent page counts or lengths. Retry with a smaller date range; the current dataset has not been replaced.");
    const pages = Math.max(1, result.total_pages);
    if (result.page !== page || (expectedItems !== null && (result.total_items !== expectedItems || pages !== expectedPages || result.account_number !== account || result.start_date !== returnedStart || result.end_date !== returnedEnd))) {
      throw new ApiFailure(502, "inconsistent_paypal_pages", "PayPal pagination changed while fetching. Retry with a smaller date range; the current dataset has not been replaced.");
    }
    if (Date.parse(result.start_date) !== startMs || Date.parse(result.end_date) !== endMs) throw new ApiFailure(502, "partial_paypal_window", "PayPal returned a different reporting window. Choose an earlier end date or retry with a smaller range; the current dataset has not been replaced.");
    expectedItems = result.total_items;
    expectedPages = pages;
    account = result.account_number;
    returnedStart = result.start_date;
    returnedEnd = result.end_date;
    for (const raw of result.transaction_details) {
      rawCount += 1;
      if (rawCount > MAX_ROWS) throw new ApiFailure(422, "reporting_row_limit", "The reporting result exceeds 1,000 records. Reduce the date range and try again.");
      const payment = reportPayment(raw, rawCount);
      if (Date.parse(payment.timestamp) < startMs || Date.parse(payment.timestamp) > endMs) throw new ApiFailure(502, "out_of_range_paypal_record", "PayPal returned a record outside the requested window. The current dataset has not been replaced.");
      const fingerprint = createHash("sha256").update(canonicalJson(raw)).digest("hex");
      const previous = fingerprints.get(payment.id);
      if (previous) {
        if (previous !== fingerprint) throw new ApiFailure(502, "conflicting_paypal_duplicates", "PayPal returned conflicting observations for the same event. The current dataset has not been replaced.");
        duplicateCount += 1;
        continue;
      }
      if (isEligibleReceipt(payment)) {
        if (incomingProviderIds.has(payment.providerId)) throw new ApiFailure(502, "conflicting_paypal_receipts", "PayPal returned multiple incoming events for the same receipt. Retry with a smaller date range or retrieve the individual capture. The current dataset has not been replaced.");
        incomingProviderIds.add(payment.providerId);
      }
      fingerprints.set(payment.id, fingerprint);
      payments.push(payment);
    }
    page += 1;
  } while (page <= (expectedPages ?? 1));
  if (rawCount !== expectedItems) throw new ApiFailure(502, "incomplete_paypal_pages", "PayPal returned an incomplete record count. The current dataset has not been replaced.");
  const timestamps = payments.map((payment) => payment.timestamp).sort((a, b) => Date.parse(a) - Date.parse(b));
  assertCurrent(connection);
  return paypalResponseSchema.parse({ payments, connectionId: connection.id, source: { kind: "paypal", label: "PayPal sandbox reporting · requested window; reporting may lag", coverage: "bounded-window", rangeStart: timestamps[0], rangeEnd: timestamps.at(-1), requestedRangeStart: start.data, requestedRangeEnd: end.data, filters: [{ field: "fields", value: "all" }, { field: "balance_affecting_records_only", value: "Y" }, { field: "page_size", value: "500" }], accountIdentity: account ? { kind: "account_number", value: account } : null, fetchedAt: new Date().toISOString(), unsupportedCount: payments.filter((payment) => payment.status === "unsupported").length, duplicateCount, providerVerified: true } });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readLocalRequest(request, paypalApiRequestSchema);
    if (input.operation === "status") return apiJson(connectionStatus());
    if (input.operation === "connect") return apiJson(await connect(input, request.signal));
    if (input.operation === "disconnect") return apiJson(disconnect());
    const connection = selectedConnection(input.connectionId);
    if (input.operation === "transactions") {
      const result = await reporting(connection, input, request.signal);
      assertCurrent(connection);
      return apiJson(result);
    }
    const capture = providerData(captureSchema, await paypalGet(connection, `/v2/payments/captures/${encodeURIComponent(input.captureId)}`, request.signal));
    const payment = capturePayment(capture, input.captureId);
    assertCurrent(connection);
    return apiJson(paypalResponseSchema.parse({ payments: [payment], connectionId: connection.id, source: { kind: "paypal", label: "PayPal sandbox · one capture only", coverage: "single-record", rangeStart: payment.timestamp, rangeEnd: payment.timestamp, filters: [{ field: "capture_id", value: capture.id }], accountIdentity: capture.payee?.merchant_id ? { kind: "merchant_id", value: capture.payee.merchant_id } : null, fetchedAt: new Date().toISOString(), unsupportedCount: payment.status === "unsupported" ? 1 : 0, duplicateCount: 0, providerVerified: true } }));
  } catch (error) {
    return apiError(error);
  }
}
