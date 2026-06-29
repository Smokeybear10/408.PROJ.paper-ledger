"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { investigationResponseSchema, MAX_FILE_BYTES, paypalRequestSchema, paypalResponseSchema } from "../lib/contracts";
import type { ColumnMapping, Dataset, DecisionEvidence, ImportResult, InvestigationResponse, Invoice, InvoiceResult, Payment, PayPalResponse, ReviewState, SourceInfo } from "../lib/contracts";
import { buildInvestigationRequest, caseFingerprint, confirmAllocation, EMPTY_REVIEW, exportReconciliation, formatMoney, getCsvHeaders, parseInvoiceCsv, parsePaymentCsv, reconcile, rejectAllocation, undoInvoiceReview } from "../lib/reconciliation";
import { createSampleDataset } from "../lib/sample-data";
import { buildExceptionDesk, previewAssociation, type TriageFinding } from "../lib/case-intelligence";
import { buildCaseBrief, captureDecisionEvidence, pruneDecisionEvidence } from "../lib/evidence-brief";
import InvestigationDesk from "./investigation-desk";
import CaseComparison from "./case-comparison";
import { MAX_WORKSPACE_BYTES, parseWorkspace, serializeWorkspace, type RestoredWorkspace } from "../lib/workspace-file";

type Configuration = { paypal: boolean; ai: boolean; aiProvider: "gemini" | "codex" | null };
type View = "investigations" | "all" | "review" | "resolved" | "receipts";
type Modal = "import" | "paypal" | "sources" | "sample" | "workspace" | null;
type ImportKind = "invoices" | "payments";
type CsvPreview = { kind: "invoices"; result: ImportResult<Invoice>; filename: string } | { kind: "payments"; result: ImportResult<Payment>; filename: string };
type PendingRequest = { id: string; controller: AbortController; revision: number; fingerprint?: string };
const EMPTY_DATASET: Dataset = { invoices: [], payments: [], invoiceSource: null, paymentSource: null, revision: 0 };
const PAGE_SIZE = 12;
const LABELS: Record<InvoiceResult["status"], string> = { "needs-review": "Needs review", covered: "Gross covered", partial: "Confirmed partial", overpaid: "Overpayment", refund: "Refund exception", unmatched: "Unmatched", pending: "Receipt pending" };
const NEXT_STEPS: Record<InvestigationResponse["proposal"]["category"], string> = { reference_interpretation: "Verify the quoted phrase against the original receipt, then manually review the proposed invoice association.", ambiguous: "Inspect the original record or request an invoice reference. Leave the association unconfirmed while the reference is ambiguous.", no_supported_match: "Request an invoice reference or inspect the original record. Leave the association unconfirmed until supporting evidence is available." };
const INVOICE_FIELDS = [["id", "Invoice ID *"], ["customer", "Customer name *"], ["customerKey", "Customer ID"], ["currency", "Currency *"], ["amount", "Amount (USD decimal) *"], ["dueDate", "Due date *"]];
const PAYMENT_FIELDS = [["id", "Record ID (optional; defaults to provider ID)"], ["providerId", "Provider transaction ID *"], ["eventCode", "Event code"], ["kind", "Event kind"], ["status", "Status *"], ["timestamp", "Timestamp *"], ["currency", "Currency *"], ["gross", "Gross amount *"], ["fee", "Fee cost"], ["net", "Net amount"], ["invoiceId", "Invoice reference"], ["customerKey", "Customer ID"], ["memo", "Remittance / memo"], ["referenceId", "Related transaction ID"], ["referenceType", "Related ID type"]];

function Icon({ name, className = "" }: { name: "ledger" | "receipt" | "source" | "upload" | "download" | "arrow" | "search" | "close" | "check" | "back" | "info" | "spark"; className?: string }) {
  const paths: Record<string, ReactNode> = {
    ledger: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M8 7h8M8 11h8M8 15h3M8 18h3" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3" /></>,
    source: <><path d="M4 6h6l2 2h8v12H4zM4 6V4h7l2 2h7v2" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
    download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    back: <path d="m11 5-7 7 7 7M4 12h16" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function apiError(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = value.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

function dateLabel(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", timeZone: "UTC" }).format(date);
}

function sourceLabel(source: SourceInfo | null): string {
  if (!source) return "No source loaded";
  return source.kind === "sample" ? "Sample dataset" : source.kind === "paypal" ? "PayPal sandbox response" : "Imported file";
}

function coverageLabel(source: SourceInfo | null): string {
  if (!source) return "No payment data";
  const labels: Record<SourceInfo["coverage"], string> = { sample: "Sample only", "file-defined": "File-defined coverage", "bounded-window": "Requested window fetched", "single-record": "One capture only", partial: "Partial coverage", unknown: "Coverage unknown" };
  return labels[source.coverage];
}

function Status({ row }: { row: InvoiceResult }) {
  return <span className={`status status-${row.status}`}>{LABELS[row.status]}</span>;
}

export default function Workspace({ configuration }: { configuration: Configuration }) {
  const aiProviderLabel = configuration.aiProvider === "codex" ? "Codex" : "Gemini";
  const aiDestination = configuration.aiProvider === "codex" ? "OpenAI via Codex" : configuration.aiProvider === "gemini" ? "Google Gemini" : "the configured AI provider";
  const [dataset, setDataset] = useState<Dataset>(EMPTY_DATASET);
  const [review, setReview] = useState<ReviewState>(EMPTY_REVIEW);
  const [decisionEvidence, setDecisionEvidence] = useState<DecisionEvidence[]>([]);
  const decisionEvidenceRef = useRef<DecisionEvidence[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [activePaymentId, setActivePaymentId] = useState<string | null>(null);
  const [excerpt, setExcerpt] = useState("");
  const [excerptApproved, setExcerptApproved] = useState(false);
  const [ai, setAi] = useState<InvestigationResponse | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [view, setView] = useState<View>("investigations");
  const [query, setQuery] = useState("");
  const [findingKind, setFindingKind] = useState<TriageFinding["kind"] | "all">("all");
  const [page, setPage] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [importKind, setImportKind] = useState<ImportKind>("invoices");
  const [csvText, setCsvText] = useState("");
  const [csvFilename, setCsvFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [paypalOperation, setPaypalOperation] = useState<"capture" | "transactions">("capture");
  const [captureId, setCaptureId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [paypalBusy, setPaypalBusy] = useState(false);
  const [paypalError, setPaypalError] = useState("");
  const [paypalPreview, setPaypalPreview] = useState<(PayPalResponse & { revision: number }) | null>(null);
  const [workspacePreview, setWorkspacePreview] = useState<RestoredWorkspace | null>(null);
  const [workspaceFilename, setWorkspaceFilename] = useState("");
  const [workspaceReadBusy, setWorkspaceReadBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSaveStarted, setWorkspaceSaveStarted] = useState(false);
  const snapshot = useRef({ dataset: EMPTY_DATASET, review: EMPTY_REVIEW, selectedId: null as string | null, excerpt: "", excerptPaymentId: null as string | null });
  const aiRequest = useRef<PendingRequest | null>(null);
  const paypalRequest = useRef<PendingRequest | null>(null);
  const fileRequest = useRef(0);
  const workspaceFileRequest = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const caseHeadingRef = useRef<HTMLHeadingElement>(null);
  const ledgerSearchRef = useRef<HTMLInputElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectionOrigin = useRef<string | null>(null);

  const reconciliation = useMemo(() => reconcile(dataset, review), [dataset, review]);
  const desk = useMemo(() => buildExceptionDesk(dataset, review), [dataset, review]);
  const decisionPreview = useMemo(() => selectedId && checkedIds.length ? previewAssociation(dataset, review, selectedId, checkedIds) : null, [dataset, review, selectedId, checkedIds]);
  const allocatedPaymentIds = new Set(review.allocations.map((allocation) => allocation.paymentId));
  const unallocatedRecords = dataset.payments.filter((payment) => !allocatedPaymentIds.has(payment.id));
  const selected = reconciliation.rows.find((row) => row.invoice.id === selectedId) ?? null;
  const reviewableCandidates = selected?.candidatePayments.filter((candidate) => !selected.confirmedPayments.some((payment) => payment.id === candidate.payment.id)) ?? [];
  const selectedPayments = selected ? [...new Map([...selected.candidatePayments.map((candidate) => candidate.payment), ...selected.confirmedPayments].map((payment) => [payment.id, payment])).values()] : [];
  const activePayment = selectedPayments.find((payment) => payment.id === activePaymentId) ?? null;
  const visibleFindings = desk.findings.filter((finding) => (findingKind === "all" || finding.kind === findingKind) && `${finding.title} ${finding.description} ${finding.invoiceIds.join(" ")} ${finding.paymentIds.join(" ")} ${finding.kind}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleRows = reconciliation.rows.filter((row) => {
    const matchesQuery = `${row.invoice.id} ${row.invoice.customer} ${row.invoice.customerKey}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (view === "review" ? row.status !== "covered" : view === "resolved" ? row.status === "covered" : true);
  });
  const visibleReceipts = unallocatedRecords.filter((payment) => `${payment.id} ${payment.providerId} ${payment.invoiceId ?? ""} ${payment.status}`.toLowerCase().includes(query.trim().toLowerCase()));
  const totalVisible = view === "investigations" ? visibleFindings.length : view === "receipts" ? visibleReceipts.length : visibleRows.length;
  const pageCount = Math.max(1, Math.ceil(totalVisible / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRows = visibleRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pagedReceipts = visibleReceipts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pagedFindings = visibleFindings.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const loaded = dataset.invoices.length > 0 || dataset.payments.length > 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modal) {
      if (!dialog.open) {
        dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
      dialog.scrollTop = 0;
      dialogTitleRef.current?.focus({ preventScroll: true });
    } else if (dialog.open) {
      dialog.close();
      if (dialogTriggerRef.current?.isConnected) dialogTriggerRef.current.focus({ preventScroll: true });
      dialogTriggerRef.current = null;
    }
  }, [modal]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => () => { aiRequest.current?.controller.abort(); paypalRequest.current?.controller.abort(); }, []);

  function invalidateAi() {
    aiRequest.current?.controller.abort();
    aiRequest.current = null;
    setAi(null);
    setAiBusy(false);
    setAiError("");
  }

  function closeModal() {
    fileRequest.current += 1;
    workspaceFileRequest.current += 1;
    setWorkspaceReadBusy(false);
    paypalRequest.current?.controller.abort();
    paypalRequest.current = null;
    setPaypalBusy(false);
    setModal(null);
  }

  function chooseCase(id: string, openDetail = true) {
    const current = snapshot.current;
    if (current.selectedId !== id) setDecisionNote("");
    invalidateAi();
    const row = reconcile(current.dataset, current.review).rows.find((result) => result.invoice.id === id);
    snapshot.current = { ...current, selectedId: id, excerpt: "" };
    setSelectedId(id);
    const referenced = row?.candidatePayments.filter((candidate) => candidate.eligible && candidate.match === "reference" && !row.confirmedPayments.some((payment) => payment.id === candidate.payment.id)).map((candidate) => candidate.payment.id) ?? [];
    const firstEligible = row?.candidatePayments.find((candidate) => candidate.eligible && !row.confirmedPayments.some((payment) => payment.id === candidate.payment.id))?.payment.id;
    const owner = firstEligible ?? row?.confirmedPayments[0]?.id ?? row?.candidatePayments[0]?.payment.id ?? null;
    snapshot.current = { ...snapshot.current, excerptPaymentId: owner };
    setActivePaymentId(owner);
    setCheckedIds(referenced.length ? referenced : firstEligible ? [firstEligible] : []);
    setExcerpt("");
    setExcerptApproved(false);
    setDecisionError("");
    selectionOrigin.current = id;
    if (openDetail) {
      setMobileDetail(true);
      requestAnimationFrame(() => caseHeadingRef.current?.focus());
    }
  }

  function commitDataset(next: Dataset) {
    invalidateAi();
    fileRequest.current += 1;
    workspaceFileRequest.current += 1;
    setWorkspaceReadBusy(false);
    setWorkspacePreview(null);
    setImportBusy(false);
    setDecisionNote("");
    paypalRequest.current?.controller.abort();
    paypalRequest.current = null;
    setPaypalBusy(false);
    setPaypalPreview(null);
    const freshReview: ReviewState = { allocations: [], rejections: [], revision: snapshot.current.review.revision + 1 };
    const revision = snapshot.current.dataset.revision + 1;
    const freshDataset = { ...next, revision };
    snapshot.current = { dataset: freshDataset, review: freshReview, selectedId: null, excerpt: "", excerptPaymentId: null };
    decisionEvidenceRef.current = [];
    setDecisionEvidence([]);
    setDataset(freshDataset);
    setReview(freshReview);
    setSelectedId(null);
    setActivePaymentId(null);
    setCheckedIds([]);
    setExcerpt("");
    setExcerptApproved(false);
    setDecisionError("");
    setView("investigations");
    setFindingKind("all");
    setQuery("");
    setPage(0);
    setMobileDetail(false);
    if (freshDataset.invoices[0]) chooseCase(freshDataset.invoices[0].id, false);
  }

  function commitReview(next: ReviewState) {
    invalidateAi();
    setDecisionNote("");
    const current = snapshot.current;
    const row = reconcile(current.dataset, next).rows.find((result) => result.invoice.id === current.selectedId);
    const payments = [...(row?.candidatePayments.map((candidate) => candidate.payment) ?? []), ...(row?.confirmedPayments ?? [])];
    const owner = payments.find((payment) => payment.id === current.excerptPaymentId)?.id ?? payments[0]?.id ?? null;
    snapshot.current = { ...current, review: next, excerpt: "", excerptPaymentId: owner };
    setActivePaymentId(owner);
    setExcerpt("");
    setReview(next);
    setExcerptApproved(false);
    setDecisionError("");
  }

  function loadSample() {
    commitDataset(createSampleDataset());
    closeModal();
    setToast("Sample ledger loaded. All associations await your review; no provider or AI call was made.");
  }

  function selectView(next: View) {
    setView(next);
    setPage(0);
    setMobileDetail(false);
  }

  function changeExcerpt(next: string) {
    invalidateAi();
    snapshot.current = { ...snapshot.current, excerpt: next };
    setExcerpt(next);
    setExcerptApproved(false);
  }

  function chooseReceiptOwner(id: string) {
    if (snapshot.current.excerptPaymentId !== id) setDecisionNote("");
    invalidateAi();
    snapshot.current = { ...snapshot.current, excerpt: "", excerptPaymentId: id };
    setActivePaymentId(id);
    setExcerpt("");
    setExcerptApproved(false);
    setDecisionError("");
  }

  function changeReceiptSelection(id: string, checked: boolean) {
    const next = checked ? [...checkedIds, id] : checkedIds.filter((item) => item !== id);
    setCheckedIds(next);
    chooseReceiptOwner(checked ? id : next[0] ?? selectedPayments[0]?.id ?? id);
  }

  function changeImportKind(next: ImportKind) {
    fileRequest.current += 1;
    setImportKind(next);
    setCsvText("");
    setCsvFilename("");
    setHeaders([]);
    setMapping({});
    setCsvPreview(null);
    setImportError("");
    setImportBusy(false);
  }

  function openWorkspaceFiles() {
    workspaceFileRequest.current += 1;
    setWorkspacePreview(null);
    setWorkspaceFilename("");
    setWorkspaceReadBusy(false);
    setWorkspaceError("");
    setWorkspaceSaveStarted(false);
    setModal("workspace");
  }

  function saveWorkspace() {
    const current = snapshot.current;
    setWorkspaceError("");
    setWorkspaceSaveStarted(false);
    try {
      const text = serializeWorkspace(current.dataset, current.review, current.selectedId);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `paper-ledger-workspace-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setWorkspaceSaveStarted(true);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "The workspace could not be saved. Your current data has been kept.");
    }
  }

  async function readWorkspace(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const requestId = ++workspaceFileRequest.current;
    setWorkspacePreview(null);
    setWorkspaceFilename(file.name);
    setWorkspaceError("");
    setWorkspaceReadBusy(true);
    try {
      if (file.size > MAX_WORKSPACE_BYTES) throw new Error("This workspace exceeds the 16 MiB limit. Choose a smaller workspace JSON file.");
      if (file.size === 0) throw new Error("This file is empty. Choose a saved Paper Ledger workspace JSON file.");
      const text = await file.text();
      if (requestId !== workspaceFileRequest.current) return;
      const restored = parseWorkspace(text);
      if (requestId !== workspaceFileRequest.current) return;
      setWorkspacePreview(restored);
    } catch (error) {
      if (requestId === workspaceFileRequest.current) setWorkspaceError(error instanceof Error ? error.message : "The workspace file could not be opened. Your current workspace has been kept.");
    } finally {
      if (requestId === workspaceFileRequest.current) setWorkspaceReadBusy(false);
    }
  }

  function restoreWorkspace() {
    const restored = workspacePreview;
    if (!restored) return;
    invalidateAi();
    paypalRequest.current?.controller.abort();
    paypalRequest.current = null;
    fileRequest.current += 1;
    workspaceFileRequest.current += 1;
    setPaypalBusy(false);
    setPaypalPreview(null);
    setImportBusy(false);
    setCsvPreview(null);
    setCsvText("");
    setCsvFilename("");
    setHeaders([]);
    setMapping({});
    setImportError("");
    setWorkspaceReadBusy(false);
    const savedSelection = restored.dataset.invoices.some((invoice) => invoice.id === restored.selectedInvoiceId) ? restored.selectedInvoiceId : restored.dataset.invoices[0]?.id ?? null;
    snapshot.current = { dataset: restored.dataset, review: restored.review, selectedId: null, excerpt: "", excerptPaymentId: null };
    decisionEvidenceRef.current = [];
    setDecisionEvidence([]);
    setDataset(restored.dataset);
    setReview(restored.review);
    setSelectedId(null);
    setActivePaymentId(null);
    setCheckedIds([]);
    setExcerpt("");
    setExcerptApproved(false);
    setDecisionNote("");
    setDecisionError("");
    setView("investigations");
    setFindingKind("all");
    setQuery("");
    setPage(0);
    setMobileDetail(false);
    selectionOrigin.current = null;
    if (savedSelection) chooseCase(savedSelection, false);
    setWorkspacePreview(null);
    closeModal();
    setToast("Records and manual decisions restored. Imported workspace sources are unverified; AI results and evidence were cleared.");
  }

  async function readCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const requestId = ++fileRequest.current;
    setCsvPreview(null);
    setImportError("");
    setImportBusy(true);
    setCsvText("");
    setHeaders([]);
    setCsvFilename(file.name);
    setMapping({});
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("The file is larger than 2 MB. Choose a smaller CSV.");
      if (file.size === 0) throw new Error("This file is empty. Choose a CSV with a header and at least one data row.");
      const text = await file.text();
      if (requestId !== fileRequest.current) return;
      const columns = getCsvHeaders(text);
      if (!columns.length) throw new Error("No column headers were found in this CSV.");
      setCsvText(text);
      setHeaders(columns);
    } catch (error) {
      if (requestId === fileRequest.current) setImportError(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      if (requestId === fileRequest.current) setImportBusy(false);
    }
  }

  function previewCsv() {
    setImportError("");
    setCsvPreview(null);
    const selectedMapping = Object.fromEntries(Object.entries(mapping).filter(([, value]) => value));
    try {
      if (importKind === "invoices") setCsvPreview({ kind: "invoices", result: parseInvoiceCsv(csvText, selectedMapping), filename: csvFilename });
      else setCsvPreview({ kind: "payments", result: parsePaymentCsv(csvText, selectedMapping), filename: csvFilename });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "The CSV could not be validated. Check its mapping and decimal amounts.");
    }
  }

  function applyCsv() {
    if (!csvPreview || csvPreview.result.issues.length || !csvPreview.result.records.length) return;
    const dates = csvPreview.result.records.map((row) => "dueDate" in row ? row.dueDate : row.timestamp).sort();
    const source: SourceInfo = { kind: "file", label: csvPreview.filename, coverage: "file-defined", rangeStart: dates[0], rangeEnd: dates.at(-1), unsupportedCount: csvPreview.kind === "payments" ? csvPreview.result.records.filter((row) => row.status === "unsupported").length : 0, duplicateCount: csvPreview.result.duplicateCount, providerVerified: false };
    const current = snapshot.current.dataset;
    if (csvPreview.kind === "invoices") commitDataset({ ...current, invoices: csvPreview.result.records, invoiceSource: source });
    else commitDataset({ ...current, payments: csvPreview.result.records, paymentSource: source });
    closeModal();
    setToast(`${csvPreview.kind === "invoices" ? "Invoice" : "Payment"} collection replaced. Prior review decisions and AI results were cleared.`);
  }

  function resetPaypalPreview() {
    paypalRequest.current?.controller.abort();
    paypalRequest.current = null;
    setPaypalBusy(false);
    setPaypalPreview(null);
    setPaypalError("");
  }

  async function fetchPaypal() {
    paypalRequest.current?.controller.abort();
    setPaypalError("");
    setPaypalPreview(null);
    const parsed = paypalRequestSchema.safeParse(paypalOperation === "capture" ? { operation: "capture", captureId: captureId.trim() } : { operation: "transactions", startDate: startDate ? `${startDate}T00:00:00.000Z` : "", endDate: endDate ? `${endDate}T23:59:59.000Z` : "" });
    if (!parsed.success) { setPaypalError("Enter a valid capture ID, or both dates for a reporting window of at most 31 days."); return; }
    const request = { id: crypto.randomUUID(), controller: new AbortController(), revision: snapshot.current.dataset.revision };
    paypalRequest.current = request;
    setPaypalBusy(true);
    try {
      const response = await fetch("/api/paypal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data), signal: request.controller.signal });
      const body: unknown = await response.json();
      if (paypalRequest.current?.id !== request.id || snapshot.current.dataset.revision !== request.revision) return;
      if (!response.ok) throw new Error(apiError(body, "The sandbox request failed. Your current payment data has been kept."));
      const result = paypalResponseSchema.safeParse(body);
      if (!result.success) throw new Error("The sandbox response did not pass validation. Your current payment data has been kept.");
      setPaypalPreview({ ...result.data, revision: request.revision });
    } catch (error) {
      if (paypalRequest.current?.id === request.id && !request.controller.signal.aborted) setPaypalError(error instanceof Error ? error.message : "The PayPal sandbox could not be reached.");
    } finally {
      if (paypalRequest.current?.id === request.id) { setPaypalBusy(false); paypalRequest.current = null; }
    }
  }

  function applyPaypal() {
    if (!paypalPreview || paypalPreview.revision !== snapshot.current.dataset.revision) { setPaypalError("This preview is stale. Fetch the source again before replacing payment data."); return; }
    commitDataset({ ...snapshot.current.dataset, payments: paypalPreview.payments, paymentSource: paypalPreview.source });
    closeModal();
    setToast("Sandbox records applied to the reconciliation. Invoice data was preserved; prior decisions and AI were cleared.");
  }

  async function investigate() {
    const current = snapshot.current;
    if (!configuration.ai || !current.selectedId || !excerptApproved || !current.excerpt.trim()) return;
    invalidateAi();
    const id = crypto.randomUUID();
    try {
      const packet = buildInvestigationRequest(current.dataset, current.review, current.selectedId, current.excerpt, id, current.excerptPaymentId ?? undefined);
      const request = { id, fingerprint: packet.fingerprint, revision: current.dataset.revision, controller: new AbortController() };
      aiRequest.current = request;
      setAiBusy(true);
      try {
        const response = await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet), signal: request.controller.signal });
        const body: unknown = await response.json();
        const latest = snapshot.current;
        if (aiRequest.current?.id !== id || !latest.selectedId || caseFingerprint(latest.dataset, latest.review, latest.selectedId, latest.excerpt, latest.excerptPaymentId ?? undefined) !== request.fingerprint) return;
        if (!response.ok) throw new Error(apiError(body, "The investigation failed. Your evidence and decisions have been kept."));
        const result = investigationResponseSchema.safeParse(body);
        if (!result.success || result.data.requestId !== id || result.data.fingerprint !== request.fingerprint) throw new Error("The investigation response did not pass validation. No proposal was applied.");
        setAi(result.data);
      } catch (error) {
        if (aiRequest.current?.id === id && !request.controller.signal.aborted) setAiError(error instanceof Error ? error.message : "The investigation could not be completed.");
      } finally {
        if (aiRequest.current?.id === id) { setAiBusy(false); aiRequest.current = null; }
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "This case cannot be investigated. Select eligible evidence and preview an excerpt.");
    }
  }

  function decide(action: "confirm" | "reject" | "undo") {
    const current = snapshot.current;
    if (!current.selectedId) return;
    try {
      const next = action === "confirm" ? confirmAllocation(current.dataset, current.review, current.selectedId, checkedIds, decisionNote.trim() || "Confirmed after reviewing source evidence") : action === "undo" ? undoInvoiceReview(current.review, current.selectedId) : checkedIds.reduce((state, id) => rejectAllocation(current.dataset, state, current.selectedId!, id, decisionNote.trim() || "Rejected after reviewing source evidence."), current.review);
      const captured = action === "undo" ? [] : captureDecisionEvidence({ dataset: current.dataset, before: current.review, after: next, invoiceId: current.selectedId, paymentIds: checkedIds, action, investigation: ai, excerpt: current.excerpt, excerptPaymentId: current.excerptPaymentId ?? "" });
      const retained = pruneDecisionEvidence([...decisionEvidenceRef.current, ...captured], current.dataset, next);
      decisionEvidenceRef.current = retained;
      setDecisionEvidence(retained);
      commitReview(next);
      if (action !== "undo") setCheckedIds([]);
      setToast(action === "confirm" ? "Association confirmed. Competing candidates and confirmed totals were recomputed." : action === "reject" ? "Association rejected. The receipt remains available for other invoices." : "Review undone. Receipts are available for review again.");
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "This decision could not be applied. Review the current receipt availability.");
    }
  }

  function downloadReview() {
    const csv = exportReconciliation(snapshot.current.dataset, snapshot.current.review);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `paper-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("Review CSV exported locally, including unresolved states and source coverage. This is not a durable audit log.");
  }

  function downloadBrief() {
    const current = snapshot.current;
    if (!current.selectedId) return;
    try {
      const html = buildCaseBrief({ dataset: current.dataset, review: current.review, invoiceId: current.selectedId, decisionEvidence: decisionEvidenceRef.current, investigation: ai && current.excerptPaymentId ? { response: ai, excerpt: current.excerpt, excerptPaymentId: current.excerptPaymentId } : null });
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      const filename = current.selectedId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "case";
      anchor.href = url;
      anchor.download = `paper-ledger-${filename}-evidence.html`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("Evidence brief download started. It contains the selected case, source coverage and current review decisions.");
    } catch (error) {
      setToast(`Evidence brief download failed: ${error instanceof Error ? error.message : "the case could not be prepared"}`);
    }
  }

  function chooseComparisonInvoice(id: string) {
    const current = snapshot.current;
    const row = reconcile(current.dataset, current.review).rows.find((result) => result.invoice.id === id);
    if (!row) return;
    const receiptId = current.excerptPaymentId;
    const confirmed = receiptId ? row.confirmedPayments.some((payment) => payment.id === receiptId) : false;
    const candidate = receiptId ? row.candidatePayments.find((item) => item.payment.id === receiptId) : undefined;
    chooseCase(id);
    if (receiptId && (candidate || confirmed)) {
      chooseReceiptOwner(receiptId);
      setCheckedIds(confirmed || !candidate?.eligible ? [] : [receiptId]);
    }
  }

  function inspectReceipt(id: string) {
    selectView("receipts");
    setQuery(id);
    requestAnimationFrame(() => ledgerSearchRef.current?.focus());
  }

  function goBack() {
    setMobileDetail(false);
    requestAnimationFrame(() => {
      const id = selectionOrigin.current;
      const originatingRow = id ? rowButtons.current.get(id) : null;
      (originatingRow ?? ledgerSearchRef.current)?.focus();
    });
  }

  const reviewCount = reconciliation.rows.filter((row) => row.status !== "covered").length;
  const hasSelectedReview = selectedId && (review.allocations.some((allocation) => allocation.invoiceId === selectedId) || review.rejections.some((rejection) => rejection.invoiceId === selectedId));

  return <div className="app">
    <header className="workspace-header"><a className="brand" href="#workspace">Paper Ledger</a><nav aria-label="Workspace navigation"><button className={view === "investigations" ? "active" : ""} aria-pressed={view === "investigations"} onClick={() => selectView("investigations")}>Investigations{loaded && <span className="nav-count">{desk.findings.length}</span>}</button><button className={view !== "receipts" && view !== "investigations" ? "active" : ""} aria-pressed={view !== "receipts" && view !== "investigations"} onClick={() => selectView("all")}>Invoice ledger{loaded && <span className="nav-count">{dataset.invoices.length}</span>}</button><button className={view === "receipts" ? "active" : ""} aria-pressed={view === "receipts"} onClick={() => selectView("receipts")}>Receipts{loaded && <span className="nav-count">{unallocatedRecords.length}</span>}</button><button aria-haspopup="dialog" onClick={() => setModal("sources")}>Sources</button></nav><div className="heading-actions"><button onClick={openWorkspaceFiles}><Icon name="source" />Workspace</button><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}><Icon name="upload" />Import files</button><button onClick={() => { setPaypalError(""); setPaypalPreview(null); setModal("paypal"); }}>PayPal sandbox</button>{loaded && <button className="primary" onClick={downloadReview}><Icon name="download" />Export review</button>}</div></header>
    <main className="shell" id="workspace"><h1 className="sr-only">{view === "investigations" ? "Investigations" : view === "receipts" ? "Receipts" : "Invoice ledger"}</h1><div className="workbench-heading"><span>{dataset.invoices.length} invoices · {dataset.payments.length} payment records · USD{dataset.paymentSource?.rangeStart ? ` · Observed ${dateLabel(dataset.paymentSource.rangeStart)}${dataset.paymentSource.rangeEnd && dataset.paymentSource.rangeEnd !== dataset.paymentSource.rangeStart ? `–${dateLabel(dataset.paymentSource.rangeEnd)}` : ""}` : ""}</span><button className="source-badge" onClick={() => setModal("sources")}>{dataset.paymentSource ? <>{sourceLabel(dataset.paymentSource)} · {dataset.paymentSource.kind === "sample" ? "synthetic / unverified" : dataset.paymentSource.providerVerified ? "returned sandbox records only" : "unverified"}</> : "No payments loaded"}<Icon name="arrow" /></button></div>
      {!loaded ? <section className="empty-workspace" aria-labelledby="empty-title"><h2 id="empty-title">Import invoices and receipts</h2><p>Import invoice and payment CSVs, or load six sample invoices with ambiguous references, fees and partial receipts.</p><div className="empty-actions"><button className="primary" onClick={loadSample}>Load sample ledger<Icon name="arrow" /></button><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}>Import your files</button></div><div className="empty-footnote"><Icon name="info" /><span>The sample is synthetic. No PayPal or AI request is made.<br />Save a workspace file to keep records and manual decisions before closing or refreshing this tab.</span></div></section> : <div className={`workspace ${view === "investigations" ? "workbench-view" : "table-view"} ${mobileDetail ? "show-detail" : ""}`}>
        <section className="ledger" aria-label={view === "investigations" ? "Investigation queue" : view === "receipts" ? "Receipt ledger" : "Invoice ledger"}>{view !== "investigations" && <div className="tabs" role="group" aria-label="Ledger views"><button className={`tab ${view === "all" ? "active" : ""}`} aria-pressed={view === "all"} onClick={() => selectView("all")}>All invoices <span>{dataset.invoices.length}</span></button><button className={`tab ${view === "review" ? "active" : ""}`} aria-pressed={view === "review"} onClick={() => selectView("review")}>Needs review <span>{reviewCount}</span></button><button className={`tab ${view === "resolved" ? "active" : ""}`} aria-pressed={view === "resolved"} onClick={() => selectView("resolved")}>Covered <span>{reconciliation.stats.coveredCount}</span></button><button className={`tab receipt-tab ${view === "receipts" ? "active" : ""}`} aria-pressed={view === "receipts"} onClick={() => selectView("receipts")}>Unallocated <span>{unallocatedRecords.length}</span></button></div>}
          {view === "investigations" ? <InvestigationDesk dataset={dataset} desk={desk} findings={pagedFindings} totalFindings={totalVisible} selectedId={selectedId} query={query} kind={findingKind} onKind={(kind) => { setFindingKind(kind); setPage(0); }} searchRef={ledgerSearchRef} onQuery={(value) => { setQuery(value); setPage(0); }} onInvoice={(id) => chooseCase(id)} onReceipt={inspectReceipt} onLedger={() => selectView("all")} invoiceButtonRef={(id, element) => { if (element) rowButtons.current.set(id, element); else rowButtons.current.delete(id); }} /> : <><div className="table-tools"><label className="search"><span className="search-label">Search {view === "receipts" ? "receipts" : "invoices"}</span><Icon name="search" /><input ref={ledgerSearchRef} type="search" placeholder={view === "receipts" ? "Receipt or reference" : "Invoice or customer"} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label><span className="table-note">Confirmed allocations only</span></div>
          <div className="table-scroll">{view !== "receipts" ? <table><caption className="sr-only">Invoices and confirmed allocations. Select an invoice to review its evidence.</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col" className="number">Amount</th><th scope="col" className="number">Confirmed</th><th scope="col">Review state</th></tr></thead><tbody>{pagedRows.map((row) => <tr key={row.invoice.id} className={selectedId === row.invoice.id ? "selected" : ""}><td><button ref={(element) => { if (element) rowButtons.current.set(row.invoice.id, element); else rowButtons.current.delete(row.invoice.id); }} className="row-link invoice-id" onClick={() => chooseCase(row.invoice.id)} aria-label={`Review ${row.invoice.id}, ${row.invoice.customer}`} aria-current={selectedId === row.invoice.id ? "true" : undefined}>{row.invoice.id}</button><span className="cell-sub">Due {dateLabel(row.invoice.dueDate)}</span></td><td className="customer-cell">{row.invoice.customer}<span className="cell-sub">{row.invoice.customerKey || "No customer ID"}</span></td><td className="number">{formatMoney(row.invoice.amountMinor)}</td><td className="number confirmed-cell">{formatMoney(row.confirmedGrossMinor)}</td><td><Status row={row} /></td></tr>)}</tbody></table> : <table><caption className="sr-only">Unallocated payment records, including ineligible and unsupported events.</caption><thead><tr><th scope="col">Receipt / event</th><th scope="col">Reference</th><th scope="col" className="number">Gross</th><th scope="col">Status</th></tr></thead><tbody>{pagedReceipts.map((payment) => <tr key={payment.id}><td><strong className="invoice-id">{payment.id}</strong><span className="cell-sub">{payment.eventCode || payment.kind} · {dateLabel(payment.timestamp)}</span></td><td>{payment.invoiceId || "Not supplied"}<span className="cell-sub">{payment.kind}</span></td><td className="number">{formatMoney(payment.grossMinor)}</td><td><span className={`status ${payment.status === "completed" ? "status-neutral" : "status-pending"}`}>{payment.status.replaceAll("_", " ")}</span></td></tr>)}</tbody></table>}</div>
          {totalVisible === 0 && <div className="no-results"><Icon name={view === "receipts" ? "receipt" : "search"} /><h3>{query ? "No records match this search." : view === "resolved" ? "No confirmed coverage yet." : view === "receipts" ? "No unallocated payment records." : "No invoices in this view."}</h3><p>{query ? "Try a different invoice, customer or receipt ID." : !dataset.invoices.length ? "Import your invoice CSV to match against the loaded payment records." : "Suggestions stay separate until you review an association."}</p>{query ? <button onClick={() => setQuery("")}>Clear search</button> : <button onClick={() => selectView("all")}>View all invoices</button>}</div>}
          </>}<div className="ledger-bottom"><span>{totalVisible ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, totalVisible)} of ${totalVisible}` : `0 ${view === "investigations" ? "findings" : "records"}`}<span className="ledger-source-kind"> · {dataset.paymentSource?.kind === "sample" ? "sample" : "loaded"} {view === "investigations" ? "findings" : "records"}</span></span><div className="pagination"><button aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button><span>{currentPage + 1} / {pageCount}</span><button aria-label="Next page" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>→</button></div></div>
          
        </section>
        <aside className="evidence" aria-labelledby="case-title"><button className="mobile-back text-button" onClick={goBack}><Icon name="back" />Back to ledger</button>{!selected ? <div className="evidence-placeholder"><Icon name="receipt" /><h2 id="case-title">Select an invoice</h2><p>Its source records, exact arithmetic and review actions will appear here.</p></div> : <><div className="case-heading"><div className="case-heading-main"><div className="case-header"><span>Invoice review</span><span className="case-index">{reconciliation.rows.findIndex((row) => row.invoice.id === selectedId) + 1} / {dataset.invoices.length}</span></div><h2 id="case-title" ref={caseHeadingRef} tabIndex={-1}>{selected.invoice.id}</h2><p className="case-desc">{selected.invoice.customer} <span>·</span> <span className="case-status-text">{selected.status === "needs-review" && selected.candidatePayments.some((candidate) => candidate.match !== "reference") ? "Unconfirmed match" : LABELS[selected.status]}</span></p></div><div className="case-heading-summary"><div className="case-state"><span>Suggested coverage <strong>{formatMoney(selected.suggestedGrossMinor)}</strong></span><span>Confirmed <b>{formatMoney(selected.confirmedGrossMinor)}</b></span></div><div className="case-export"><button onClick={downloadBrief}><Icon name="download" />Download evidence brief</button>{decisionEvidence.some((evidence) => evidence.invoiceId === selectedId) && <p>Validated pre-decision AI evidence is retained with this review in the brief.</p>}</div></div></div><div className="case-body"><div className="case-records"><CaseComparison dataset={dataset} reconciliation={reconciliation} invoiceId={selected.invoice.id} payment={activePayment} onInvoice={chooseComparisonInvoice} />
          <section className="evidence-section"><h3>Invoice evidence</h3><dl className="compact-facts"><div><dt>Invoice amount</dt><dd>{formatMoney(selected.invoice.amountMinor)} USD</dd></div><div><dt>Due date</dt><dd>{dateLabel(selected.invoice.dueDate)}</dd></div><div><dt>Source</dt><dd>{sourceLabel(dataset.invoiceSource)} · row {selected.invoice.sourceRow}</dd></div></dl></section>
          <section className="evidence-section"><div className="section-heading"><h3>Receipt evidence</h3><span className="muted-count">{selectedPayments.length} available / linked</span></div>{!selectedPayments.length ? <p className="small-note">No available receipt supports this invoice within the loaded data. This does not prove it is unpaid.</p> : <>{reviewableCandidates.map((candidate) => <label className={`receipt-choice ${checkedIds.includes(candidate.payment.id) ? "checked" : ""}`} key={candidate.payment.id}><input type="checkbox" checked={checkedIds.includes(candidate.payment.id)} disabled={!candidate.eligible} onChange={(event) => changeReceiptSelection(candidate.payment.id, event.target.checked)} /><span><strong>{candidate.payment.id}</strong><small>{candidate.reason}</small></span><b>{formatMoney(candidate.payment.grossMinor)}</b></label>)}{selected.confirmedPayments.map((payment) => <button key={payment.id} className="confirmed-receipt" onClick={() => chooseReceiptOwner(payment.id)}><Icon name="check" /><span>{payment.id}<small>Confirmed allocation</small></span><b>{formatMoney(payment.grossMinor)}</b></button>)}{activePayment && <><div className="source-row"><button className="text-button source-id" onClick={() => setModal("sources")}>{activePayment.id}<Icon name="arrow" /></button><span>{activePayment.status.replaceAll("_", " ")} · {dateLabel(activePayment.timestamp)}</span></div><dl className="money-bridge"><div><dt>Gross received</dt><dd>{formatMoney(activePayment.grossMinor)}</dd></div><div><dt>Fee cost</dt><dd>{activePayment.feeMinor === null ? "Unknown" : formatMoney(activePayment.feeMinor)}</dd></div><div className="net"><dt>Net receipt</dt><dd>{activePayment.netMinor === null ? "Unknown" : formatMoney(activePayment.netMinor)}</dd></div></dl><p className="small-note">{activePayment.invoiceId ? `Invoice reference: ${activePayment.invoiceId}.` : "No invoice ID supplied."} {activePayment.feeMinor === null ? "A missing fee is not a zero fee." : "Fees stay separate from gross invoice coverage."}</p>{activePayment.memo && <div className="memo-evidence"><p className="field-caption">Original remittance · {activePayment.id}</p><blockquote className="remittance">{activePayment.memo}</blockquote></div>}<details className="raw-evidence"><summary>Original normalized source fields</summary><dl className="raw-fields">{Object.entries(activePayment.raw ?? { provider_id: activePayment.providerId, event_code: activePayment.eventCode, invoice_reference: activePayment.invoiceId ?? "Missing", status: activePayment.status }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "Missing"}</dd></div>)}</dl></details></>}</>}{selected.reasons.length > 0 && <ul className="case-reasons">{selected.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</section>

          </div><section className="case-review" aria-label="Review decision"><section className="evidence-section investigation-section"><div className="ai-label"><span><Icon name="search" />Interpret remittance reference</span><span className={`configuration-tag ${configuration.ai ? "configured" : ""}`}>{configuration.ai ? `${aiProviderLabel} configured` : "Not configured"}</span></div>{!configuration.ai && <p className="configuration-note">AI is unavailable. Configure a Gemini API key or the local Codex provider on the server, then restart. Deterministic evidence and manual review remain available.</p>}<details className="excerpt-editor"><summary>Preview a redacted excerpt</summary><p className="small-note"><strong>Destination: {configuration.ai ? aiDestination : "No AI provider configured"}.</strong> Only the selected case’s amounts, dates, statuses, anonymous customer groups, source IDs and the excerpt below are sent. Name/email fields and full source rows are excluded from structured evidence. The excerpt is sent exactly as shown; remove personal details before approving.</p><label className="field-label" htmlFor="remittance-excerpt">Redacted remittance excerpt{activePayment ? ` · ${activePayment.id}` : ""}</label><textarea id="remittance-excerpt" maxLength={1200} rows={4} value={excerpt} onChange={(event) => changeExcerpt(event.target.value)} placeholder="Remove personal details, then paste the reference you want investigated." />{activePayment?.memo && <button className="text-button use-memo" onClick={() => changeExcerpt(activePayment.memo.slice(0, 1200))}>Use displayed remittance for review</button>}<p className="small-note">{excerpt.length} / 1,200 characters. Review and redact before sending.</p><label className="consent-label"><input type="checkbox" checked={excerptApproved} disabled={!excerpt.trim()} onChange={(event) => setExcerptApproved(event.target.checked)} /><span>I reviewed this excerpt and the selected case’s evidence for sending to {aiDestination}.</span></label></details><div className="investigate-actions"><button className="investigate-button" disabled={!configuration.ai || !excerptApproved || !excerpt.trim() || !selectedPayments.length || aiBusy} onClick={investigate}><Icon name="search" />{aiBusy ? "Investigating…" : "Investigate with AI"}</button>{aiBusy && <button onClick={() => { invalidateAi(); setToast("Investigation cancelled. Your source evidence was kept."); }}>Cancel</button>}</div>{aiError && <p className="inline-error" role="alert">{aiError}</p>}{ai && <div className="ai-result" aria-live="polite"><div className="ai-result-heading">Reference interpretation<span>{ai.provider === "codex" ? "Codex" : "Gemini"}</span></div><p className="ai-text">{ai.proposal.category === "reference_interpretation" && ai.proposal.invoiceId ? <>The excerpt <q>{ai.proposal.quote}</q> may refer to <strong>{ai.proposal.invoiceId}</strong>{ai.proposal.interpretedReference && ai.proposal.interpretedReference !== ai.proposal.invoiceId ? ` (${ai.proposal.interpretedReference})` : ""}. This is a hypothesis for your review.</> : ai.proposal.category === "no_supported_match" ? "The supplied excerpt did not support an invoice association." : "The evidence remains ambiguous. A supported association could not be selected."}</p><div className="citations">{ai.proposal.evidenceIds.map((id) => <span className="citation" key={id}>{id}</span>)}</div>{ai.observations.length > 0 && <details className="ai-facts"><summary>Checked amounts and status</summary><ul className="ai-observations">{ai.observations.map((observation) => <li key={observation.id}>{observation.text}</li>)}</ul></details>}<p className="ai-next-step"><strong>Proposed next step</strong>{NEXT_STEPS[ai.proposal.category]}</p><p className="small-note">No amounts or review decisions were changed. {ai.model} · {dateLabel(ai.generatedAt)}</p>{ai.proposal.invoiceId && ai.proposal.invoiceId !== selectedId && dataset.invoices.some((invoice) => invoice.id === ai.proposal.invoiceId) && <button onClick={() => chooseCase(ai.proposal.invoiceId!)}>Review {ai.proposal.invoiceId}</button>}</div>}</section><h3>Review decision</h3><div className="decision">{decisionPreview && <section className={`decision-preview ${decisionPreview.valid ? "" : "invalid"}`} aria-label="Decision preview"><p className="preview-kicker">Allocation preview</p>{decisionPreview.valid && <><div className="preview-money"><span>Confirmed gross</span><strong>{formatMoney(decisionPreview.confirmedBeforeMinor)} <span aria-hidden="true">→</span> {formatMoney(decisionPreview.confirmedAfterMinor)}</strong></div><div className="preview-remaining"><span>{decisionPreview.remainingAfterMinor < 0 ? "Overpayment after allocation" : "Remaining invoice amount"}</span><b>{formatMoney(Math.abs(decisionPreview.remainingAfterMinor))}</b></div></>}<details className="preview-calculation"><summary>Calculation details</summary><p className="preview-message">{decisionPreview.message}</p></details>{decisionPreview.valid && decisionPreview.affectedInvoiceIds.length > 0 && <p className="preview-impact">Chosen receipts leave competing suggestions for <strong>{decisionPreview.affectedInvoiceIds.join(", ")}</strong>.</p>}<span className="preview-no-change">Preview only. No allocation has changed.</span></section>}<p>{checkedIds.length ? <>Proposed association: <strong>{checkedIds.join(" + ")}</strong> → <strong>{selected.invoice.id}</strong></> : selected.confirmedPayments.length ? "Confirmed receipts contribute to this invoice’s coverage." : "Select eligible receipts to confirm or reject an association."}</p><details className="decision-note-details"><summary>Add a decision note</summary><div className="decision-note-editor"><label className="field-label" htmlFor="decision-note">Decision note <span>(optional)</span></label><textarea id="decision-note" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={4096} rows={3} placeholder="What evidence supports your confirmation or rejection?" aria-describedby="decision-note-help" /><p id="decision-note-help">Saved with your next confirm or reject decision. Not sent to AI. <span>{decisionNote.length} / 4,096</span></p></div></details><div className="decision-buttons"><button className="primary" disabled={!checkedIds.length || !decisionPreview?.valid} onClick={() => decide("confirm")}>Confirm association</button><button disabled={!checkedIds.length} onClick={() => decide("reject")}>Reject</button></div>{hasSelectedReview && <button className="text-button undo-button" onClick={() => decide("undo")}>↶ Undo this invoice’s review</button>}{decisionError && <p className="inline-error" role="alert">{decisionError}</p>}<p className="decision-note">One receipt can cover one invoice. Confirmation does not upgrade source verification.</p></div></section></div>
        </>}</aside>
      </div>}
    </main>
    <dialog ref={dialogRef} className={`workspace-dialog ${modal === "sources" ? "source-dialog" : ""}`} onCancel={(event) => { event.preventDefault(); closeModal(); }} onClose={() => { if (modal) closeModal(); }} aria-labelledby="dialog-title"><div className="dialog-header"><div><p className="eyebrow">PAPER LEDGER</p><h2 id="dialog-title" ref={dialogTitleRef} tabIndex={-1}>{modal === "import" ? "Import source files" : modal === "paypal" ? "PayPal sandbox" : modal === "sample" ? "Replace with the sample ledger?" : modal === "workspace" ? "Workspace files" : "Sources & coverage"}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={closeModal}><Icon name="close" /></button></div>
      {modal === "import" && <div className="dialog-body"><p className="dialog-intro">Preview and validate one CSV collection before replacing it. USD only · up to 1,000 rows · 2 MB per file.</p><div className="segmented-control" role="group" aria-label="CSV collection"><button className={importKind === "invoices" ? "active" : ""} aria-pressed={importKind === "invoices"} onClick={() => changeImportKind("invoices")}>Invoices</button><button className={importKind === "payments" ? "active" : ""} aria-pressed={importKind === "payments"} onClick={() => changeImportKind("payments")}>Payments</button></div><label className="file-input-label" htmlFor="csv-file"><Icon name="upload" /><span>Choose {importKind === "invoices" ? "invoice" : "payment"} CSV<small>{csvFilename || "Comma-separated file with a header row"}</small></span></label><input type="file" id="csv-file" accept=".csv,text/csv" onChange={readCsv} className="file-input" />{importBusy && <p role="status" className="small-note">Reading file…</p>}{headers.length > 0 && <><h3 className="dialog-section-title">Column mapping</h3><p className="small-note">Auto-detect recognizes documented column names. Select an exact header to override. Amounts are decimal dollars; dates use ISO YYYY-MM-DD.</p><div className="mapping-grid">{(importKind === "invoices" ? INVOICE_FIELDS : PAYMENT_FIELDS).map(([key, label]) => <label className="field-label" key={key}>{label}<select value={mapping[key] ?? ""} onChange={(event) => { setMapping((previous) => ({ ...previous, [key]: event.target.value })); setCsvPreview(null); }}><option value="">Auto-detect / not supplied</option>{headers.map((header) => <option value={header} key={header}>{header}</option>)}</select></label>)}</div><button className="primary preview-button" onClick={previewCsv}>Validate & preview</button></>}{importError && <p className="inline-error" role="alert">{importError}</p>}{csvPreview && <section className="import-preview" aria-live="polite"><h3>{csvPreview.result.issues.length ? "Correction required" : "Ready for replacement preview"}</h3><p>{csvPreview.result.records.length} valid rows · {csvPreview.result.duplicateCount} exact duplicates excluded · {csvPreview.result.issues.length} issues</p>{csvPreview.result.issues.length > 0 ? <><ul className="import-issues">{csvPreview.result.issues.slice(0, 30).map((issue, index) => <li key={`${issue.row}-${index}`}><b>Row {issue.row}:</b> {issue.message}</li>)}</ul>{csvPreview.result.issues.length > 30 && <p className="small-note">Showing 30 issues. Correct the CSV and validate it again.</p>}</> : <><div className="preview-table"><table><thead><tr><th>ID</th><th>{csvPreview.kind === "invoices" ? "Customer" : "Status"}</th><th className="number">{csvPreview.kind === "invoices" ? "Amount" : "Gross"}</th></tr></thead><tbody>{csvPreview.kind === "invoices" ? csvPreview.result.records.slice(0, 5).map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.customer}</td><td className="number">{formatMoney(row.amountMinor)}</td></tr>) : csvPreview.result.records.slice(0, 5).map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.status}</td><td className="number">{formatMoney(row.grossMinor)}</td></tr>)}</tbody></table></div><div className="replacement-notice"><Icon name="info" /><p>This replaces all {csvPreview.kind === "invoices" ? "invoices" : "payment records"}; {csvPreview.kind === "invoices" ? "payment records remain" : "invoices remain"}. Prior confirmations, rejections and AI results will be cleared. File rows remain unverified.</p></div><button className="primary" disabled={!csvPreview.result.records.length} onClick={applyCsv}>Replace {csvPreview.kind === "invoices" ? "invoices" : "payment collection"}</button></>}</section>}<details className="format-guide"><summary>CSV column and money guide</summary><p>Invoices: invoice_id, customer_name, customer_id, currency, amount, due_date. Payments: id, provider_id, event_code, kind, status, timestamp, currency, gross, fee, net, invoice_id, customer_key, memo.</p><p>Use USD decimal amounts without currency symbols, for example 500.00. Fee cost is positive for a charge. Signed net = signed gross − fee cost. Missing fee/net stay unknown. Completed incoming receipts are eligible; pending, refunded and unsupported events remain exceptions.</p></details></div>}
      {modal === "paypal" && <div className="dialog-body"><p className="dialog-intro">Read-only access to your own sandbox merchant. A capture lookup and a bounded reporting window replace the current payment source after preview.</p><div className={`connection-note ${configuration.paypal ? "configured" : ""}`}><Icon name="info" /><span>{configuration.paypal ? "Sandbox credentials are configured on the local server. Access and returned records still require verification." : "Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the local server, then restart. Existing files and samples remain usable."}</span></div><div className="segmented-control" role="group" aria-label="Sandbox operation"><button className={paypalOperation === "capture" ? "active" : ""} aria-pressed={paypalOperation === "capture"} onClick={() => { resetPaypalPreview(); setPaypalOperation("capture"); }}>Known capture</button><button className={paypalOperation === "transactions" ? "active" : ""} aria-pressed={paypalOperation === "transactions"} onClick={() => { resetPaypalPreview(); setPaypalOperation("transactions"); }}>Reporting window</button></div>{paypalOperation === "capture" ? <label className="field-label">Sandbox capture ID<input value={captureId} onChange={(event) => { resetPaypalPreview(); setCaptureId(event.target.value); }} placeholder="A capture ID from your sandbox merchant" maxLength={64} /></label> : <><div className="date-fields"><label className="field-label">Start date (UTC)<input type="date" value={startDate} onChange={(event) => { resetPaypalPreview(); setStartDate(event.target.value); }} /></label><label className="field-label">End date (UTC)<input type="date" value={endDate} onChange={(event) => { resetPaypalPreview(); setEndDate(event.target.value); }} /></label></div><p className="small-note">At most 31 days, up to 1,000 returned records. Reporting can lag recent activity by up to three hours. A fetched window is not lifetime account coverage.</p></>}<div className="provider-actions"><button className="primary" disabled={!configuration.paypal || paypalBusy} onClick={fetchPaypal}>{paypalBusy ? "Fetching sandbox evidence…" : "Fetch replacement preview"}</button>{paypalBusy && <button onClick={() => { paypalRequest.current?.controller.abort(); paypalRequest.current = null; setPaypalBusy(false); setPaypalError("Request cancelled. Your current payment collection was kept."); }}>Cancel request</button>}</div>{paypalError && <p className="inline-error" role="alert">{paypalError}</p>}{paypalPreview && <section className="import-preview" aria-live="polite"><h3>{paypalPreview.payments.length} sandbox records returned</h3><p>{coverageLabel(paypalPreview.source)} · {paypalPreview.source.unsupportedCount} unsupported events</p><div className="preview-table"><table><thead><tr><th>Record</th><th>Status</th><th className="number">Gross</th></tr></thead><tbody>{paypalPreview.payments.slice(0, 5).map((payment) => <tr key={payment.id}><td>{payment.id}</td><td>{payment.status}</td><td className="number">{formatMoney(payment.grossMinor)}</td></tr>)}</tbody></table></div><div className="replacement-notice"><Icon name="info" /><p>Replace the entire payment collection with these returned records. Invoices remain. Prior decisions and AI results clear. A known capture is one record, not an account import.</p></div><button className="primary" onClick={applyPaypal}>Apply sandbox replacement</button></section>}</div>}
      {modal === "sources" && <div className="dialog-body"><p className="dialog-intro">Source verification belongs to individual returned observations. Reviewing a match does not verify an imported file or establish complete account coverage.</p>{([{ title: "Invoice collection", source: dataset.invoiceSource, count: dataset.invoices.length }, { title: "Payment collection", source: dataset.paymentSource, count: dataset.payments.length }]).map(({ title, source, count }) => <section className="source-section" key={title}><div className="source-section-heading"><h3>{title}</h3><span>{count} records</span></div><dl className="source-facts"><div><dt>Source</dt><dd>{sourceLabel(source)}</dd></div><div><dt>Label</dt><dd>{source?.label || "Nothing loaded"}</dd></div><div><dt>Coverage</dt><dd>{coverageLabel(source)}</dd></div><div><dt>Provider verified</dt><dd>{source?.providerVerified ? "Only returned sandbox records" : "No"}</dd></div><div><dt>Observed range</dt><dd>{source?.rangeStart ? <>{source.rangeStart}{source.rangeEnd ? ` → ${source.rangeEnd}` : ""}</> : source?.kind === "paypal" && count === 0 ? "No records returned" : "Not supplied"}</dd></div><div><dt>Requested range</dt><dd>{source?.requestedRangeStart ? <>{source.requestedRangeStart}{source.requestedRangeEnd ? ` → ${source.requestedRangeEnd}` : ""}</> : "Not supplied"}</dd></div><div><dt>Query filters</dt><dd>{source?.filters?.length ? <div className="source-filter-list">{source.filters.map((filter, index) => <div key={`${filter.field}-${index}`}><span>{filter.field}</span> = {filter.value || "Not supplied"}</div>)}</div> : "Not supplied"}</dd></div><div><dt>Provider account identity</dt><dd>{source?.kind === "paypal" && source.providerVerified && source.accountIdentity ? <>{source.accountIdentity.kind === "account_number" ? "Account number" : "Merchant ID"} · {source.accountIdentity.value}</> : "Not supplied"}</dd></div>{source?.fetchedAt && <div><dt>Fetched</dt><dd>{source.fetchedAt}</dd></div>}<div><dt>Unsupported events</dt><dd>{source?.unsupportedCount ?? 0}</dd></div><div><dt>Exact duplicates excluded</dt><dd>{source?.duplicateCount ?? 0}</dd></div></dl>{source?.kind === "paypal" && <p className="small-note">Observed range describes returned records. Requested range and filters describe the API query; neither means the entire account history was retrieved.</p>}</section>)}<div className="source-actions"><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}>Import replacement</button><button onClick={() => setModal("sample")}>Load sample ledger</button></div><p className="small-note">Save a workspace file before refreshing or closing this tab to keep records and manual decisions. Workspace files exclude AI content; a CSV export is a report, not a restorable session or durable audit log.</p></div>}
      {modal === "workspace" && <div className="dialog-body"><p className="dialog-intro">Save a local file to reopen your records and manual decisions in another session. Nothing is uploaded.</p>{workspaceError && <p className="inline-error" role="alert">{workspaceError}</p>}<section className="workspace-save-section"><div className="workspace-section-title"><Icon name="download" /><h3>Save this workspace</h3></div><p>{dataset.invoices.length} {dataset.invoices.length === 1 ? "invoice" : "invoices"} · {dataset.payments.length} payment {dataset.payments.length === 1 ? "record" : "records"} · {review.allocations.length} {review.allocations.length === 1 ? "confirmation" : "confirmations"} · {review.rejections.length} {review.rejections.length === 1 ? "rejection" : "rejections"}</p><button className="primary" onClick={saveWorkspace} disabled={!loaded}><Icon name="download" />Save workspace</button>{workspaceSaveStarted && <p className="workspace-save-status" role="status"><Icon name="check" />Workspace download started. Keep the JSON file to reopen this work.</p>}<p className="small-note">Includes records and applied manual decisions. Apply a decision to save its note. AI responses, excerpts, frozen AI evidence and draft notes are excluded.{!loaded && " Load records before saving."}</p></section><section className="workspace-open-section"><div className="workspace-section-title"><Icon name="source" /><h3>Open a saved workspace</h3></div><label className="field-label" htmlFor="workspace-file">Workspace JSON file <span>· up to 16 MiB</span></label><input type="file" id="workspace-file" accept=".json,application/json" onChange={readWorkspace} className="file-input" />{workspaceFilename && <p className="workspace-filename">{workspaceFilename}</p>}{workspaceReadBusy && <div className="workspace-read-status" role="status"><span>Validating workspace…</span><button onClick={() => { workspaceFileRequest.current += 1; setWorkspaceReadBusy(false); setToast("Workspace read cancelled. Your current records and decisions were kept."); }}>Cancel read</button></div>}{workspacePreview && <section className="workspace-restore-preview" aria-live="polite"><h4>Review before restoring</h4><dl><div><dt>Saved</dt><dd><time dateTime={workspacePreview.savedAt}>{new Date(workspacePreview.savedAt).toLocaleString()}</time></dd></div><div><dt>Invoices / payments</dt><dd>{workspacePreview.dataset.invoices.length} / {workspacePreview.dataset.payments.length}</dd></div><div><dt>Confirmations / rejections</dt><dd>{workspacePreview.review.allocations.length} / {workspacePreview.review.rejections.length}</dd></div><div><dt>Selected invoice</dt><dd>{workspacePreview.selectedInvoiceId ?? (workspacePreview.dataset.invoices.length ? "First available invoice" : "No invoices")}</dd></div></dl><div className="replacement-notice"><Icon name="info" /><p>This replaces current records and decisions. Restored sources are unverified imported files, even if the original data came from a sandbox API. Current and frozen AI results are cleared; no AI content is restored.</p></div><button className="primary" onClick={restoreWorkspace}>Restore records and decisions</button></section>}</section></div>}
      {modal === "sample" && <div className="dialog-body"><p className="dialog-intro">This replaces both invoice and payment collections with a synthetic sample. Prior confirmations, rejections and AI results will be cleared.</p><p className="small-note">The sample does not make a PayPal API request or simulate a successful AI investigation.</p><div className="dialog-footer"><button onClick={closeModal}>Keep current data</button><button className="primary" onClick={loadSample}>Replace with sample</button></div></div>}
    </dialog>
    {toast && <div className="toast" role="status"><Icon name={toast.startsWith("Evidence brief download failed") ? "info" : "check"} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><Icon name="close" /></button></div>}
  </div>;
}
