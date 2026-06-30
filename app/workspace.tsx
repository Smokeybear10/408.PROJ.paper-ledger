"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { investigationResponseSchema, MAX_FILE_BYTES, paypalConnectionRequestSchema, paypalConnectionStatusSchema, paypalRequestSchema, paypalResponseSchema } from "../lib/contracts";
import type { ColumnMapping, Dataset, DecisionEvidence, ImportResult, InvestigationResponse, Invoice, InvoiceResult, Payment, PayPalConnectionRequest, PayPalConnectionStatus, PayPalResponse, ReviewState, SourceInfo } from "../lib/contracts";
import { buildInvestigationRequest, caseFingerprint, confirmAllocation, EMPTY_REVIEW, exportReconciliation, formatMoney, getCsvHeaders, getPaymentImportProfile, isEligibleReceipt, linkedAdjustment, parseInvoiceCsv, parsePaymentCsv, reconcile, rejectAllocation, undoInvoiceReview } from "../lib/reconciliation";
import { createSampleDataset } from "../lib/sample-data";
import { buildExceptionDesk, previewAssociation, type TriageFinding } from "../lib/case-intelligence";
import { buildCaseBrief, buildReviewReport, captureDecisionEvidence, pruneDecisionEvidence, retainedInvestigationScope } from "../lib/evidence-brief";
import InvestigationDesk from "./investigation-desk";
import CaseComparison from "./case-comparison";
import EvidenceMap from "./evidence-map";
import ReviewImpact, { ReviewOverview } from "./review-impact";
import ReceiptPicker from "./receipt-picker";
import InvoiceScope from "./invoice-scope";
import SourceFields from "./source-fields";
import { MAX_WORKSPACE_BYTES, parseWorkspace, serializeWorkspace, type RestoredWorkspace } from "../lib/workspace-file";

type Configuration = { paypal: boolean; ai: boolean; aiProvider: "gemini" | "codex" | null };
type View = "investigations" | "all" | "review" | "resolved" | "receipts";
type Modal = "import" | "paypal" | "sources" | "sample" | "workspace" | "receipt" | "event" | "ai-review" | null;
type ImportKind = "invoices" | "payments";
type CsvPreview = { kind: "invoices"; result: ImportResult<Invoice>; filename: string } | { kind: "payments"; result: ImportResult<Payment>; filename: string };
type PendingRequest = { id: string; controller: AbortController; revision: number; fingerprint?: string };
const EMPTY_DATASET: Dataset = { invoices: [], payments: [], invoiceSource: null, paymentSource: null, revision: 0 };
const DISCONNECTED_PAYPAL: PayPalConnectionStatus = { connected: false, authenticated: false, source: null, connectionId: null };
const PAGE_SIZE = 12;
const LABELS: Record<InvoiceResult["status"], string> = { "needs-review": "Needs review", covered: "Gross covered", partial: "Confirmed partial", overpaid: "Overpayment", refund: "Refund exception", unmatched: "Unmatched", pending: "Receipt pending" };
const NEXT_STEPS: Record<InvestigationResponse["proposal"]["category"], string> = { reference_interpretation: "Verify the quoted phrase against the original receipt, then manually review the proposed invoice association.", ambiguous: "Inspect the original record or request an invoice reference. Leave the association unconfirmed while the reference is ambiguous.", no_supported_match: "Request an invoice reference or inspect the original record. Leave the association unconfirmed until supporting evidence is available." };
const INVOICE_FIELDS = [["id", "Invoice ID *"], ["customer", "Customer name *"], ["customerKey", "Customer ID"], ["description", "Invoice description / purpose"], ["currency", "Currency *"], ["amount", "Amount (USD decimal) *"], ["dueDate", "Due date *"]];
const PAYMENT_FIELDS = [["id", "Record ID (optional; defaults to provider ID)"], ["providerId", "Provider transaction ID *"], ["eventCode", "Event code"], ["kind", "Event kind"], ["status", "Status *"], ["timestamp", "Timestamp *"], ["currency", "Currency *"], ["gross", "Gross amount *"], ["fee", "Fee cost"], ["net", "Net amount"], ["invoiceId", "Invoice reference"], ["customerKey", "Customer ID"], ["memo", "Remittance / memo"], ["referenceId", "Related transaction ID"], ["referenceType", "Related ID type"], ["balanceImpact", "Balance impact (PayPal Activity)"]];

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

async function sendPaypalConnection(input: PayPalConnectionRequest, signal: AbortSignal): Promise<PayPalConnectionStatus> {
  const response = await fetch("/api/paypal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(apiError(body, "The sandbox connection could not be checked. Your current records have been kept."));
  const status = paypalConnectionStatusSchema.safeParse(body);
  if (!status.success) throw new Error("The sandbox connection response did not pass validation.");
  return status.data;
}

function dateLabel(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", timeZone: "UTC" }).format(date);
}

function reviewTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }).format(date);
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
  const [manualReceiptIds, setManualReceiptIds] = useState<string[]>([]);
  const [excerpt, setExcerpt] = useState("");
  const [invoiceContexts, setInvoiceContexts] = useState<Record<string, string>>({});
  const [invoiceScopeIds, setInvoiceScopeIds] = useState<string[] | undefined>();
  const [excerptApproved, setExcerptApproved] = useState(false);
  const [approvedProvider, setApprovedProvider] = useState<Configuration["aiProvider"]>(null);
  const [ai, setAi] = useState<InvestigationResponse | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [view, setView] = useState<View>("investigations");
  const [query, setQuery] = useState("");
  const [findingKind, setFindingKind] = useState<TriageFinding["kind"] | "all">("all");
  const [page, setPage] = useState(0);
  const [receiptQuery, setReceiptQuery] = useState("");
  const [receiptPage, setReceiptPage] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [inspectedPaymentId, setInspectedPaymentId] = useState<string | null>(null);
  const [inspectedLinkPage, setInspectedLinkPage] = useState(0);
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
  const [paypalApplying, setPaypalApplying] = useState(false);
  const [paypalError, setPaypalError] = useState("");
  const [paypalConnection, setPaypalConnection] = useState<PayPalConnectionStatus>(DISCONNECTED_PAYPAL);
  const [paypalStatusLoaded, setPaypalStatusLoaded] = useState(false);
  const [paypalConnectionBusy, setPaypalConnectionBusy] = useState<"status" | "connect" | "disconnect" | null>(null);
  const [paypalConnectionError, setPaypalConnectionError] = useState("");
  const [sandboxClientId, setSandboxClientId] = useState("");
  const [sandboxClientSecret, setSandboxClientSecret] = useState("");
  const [appliedPaypalConnectionId, setAppliedPaypalConnectionId] = useState<string | null>(null);
  const [paypalPreview, setPaypalPreview] = useState<(PayPalResponse & { revision: number }) | null>(null);
  const [workspacePreview, setWorkspacePreview] = useState<RestoredWorkspace | null>(null);
  const [workspaceFilename, setWorkspaceFilename] = useState("");
  const [workspaceReadBusy, setWorkspaceReadBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceSaveStarted, setWorkspaceSaveStarted] = useState(false);
  const snapshot = useRef({ dataset: EMPTY_DATASET, review: EMPTY_REVIEW, selectedId: null as string | null, excerpt: "", excerptPaymentId: null as string | null, invoiceContexts: {} as Record<string, string>, invoiceScopeIds: undefined as string[] | undefined });
  const aiRequest = useRef<PendingRequest | null>(null);
  const paypalRequest = useRef<PendingRequest | null>(null);
  const paypalConnectionRequest = useRef<Pick<PendingRequest, "id" | "controller"> | null>(null);
  const paypalConnectionRef = useRef<PayPalConnectionStatus>(DISCONNECTED_PAYPAL);
  const fileRequest = useRef(0);
  const workspaceFileRequest = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const caseHeadingRef = useRef<HTMLHeadingElement>(null);
  const aiCancelRef = useRef<HTMLButtonElement>(null);
  const ledgerSearchRef = useRef<HTMLInputElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectionOrigin = useRef<string | null>(null);

  const reconciliation = useMemo(() => reconcile(dataset, review), [dataset, review]);
  const desk = useMemo(() => buildExceptionDesk(dataset, review, reconciliation), [dataset, review, reconciliation]);
  const decisionPreview = useMemo(() => selectedId && checkedIds.length ? previewAssociation(dataset, review, selectedId, checkedIds, reconciliation) : null, [dataset, review, selectedId, checkedIds, reconciliation]);
  const allocatedPaymentIds = new Set(review.allocations.map((allocation) => allocation.paymentId));
  const unallocatedRecords = dataset.payments.filter((payment) => !allocatedPaymentIds.has(payment.id));
  const selected = reconciliation.rows.find((row) => row.invoice.id === selectedId) ?? null;
  const reviewableCandidates = selected?.candidatePayments.filter((candidate) => !selected.confirmedPayments.some((payment) => payment.id === candidate.payment.id)) ?? [];
  const manuallySelectedPayments = selected ? reconciliation.unallocatedPayments.filter((payment) => manualReceiptIds.includes(payment.id) && (!payment.invoiceId?.trim() || payment.invoiceId.trim() === selected.invoice.id)) : [];
  const selectedPayments = selected ? [...new Map([...selected.candidatePayments.map((candidate) => candidate.payment), ...selected.confirmedPayments, ...manuallySelectedPayments].map((payment) => [payment.id, payment])).values()] : [];
  const activePayment = selectedPayments.find((payment) => payment.id === activePaymentId) ?? null;
  const activeIsManual = Boolean(activePayment && !selected?.candidatePayments.some((candidate) => candidate.payment.id === activePayment.id) && !selected?.confirmedPayments.some((payment) => payment.id === activePayment.id));
  const proposedPayments = selected ? [...new Map([...selected.confirmedPayments, ...selectedPayments.filter((payment) => checkedIds.includes(payment.id))].map((payment) => [payment.id, payment])).values()] : [];
  const needsDecisionNote = checkedIds.some((id) => manuallySelectedPayments.some((payment) => payment.id === id)) || Boolean(selected && proposedPayments.length > 1 && proposedPayments.some((payment) => payment.invoiceId?.trim() !== selected.invoice.id));
  const relatedInvoiceRows = useMemo(() => activePayment ? reconciliation.rows.filter((row) => row.invoice.id === selectedId || row.candidatePayments.some((candidate) => candidate.payment.id === activePayment.id) || row.confirmedPayments.some((payment) => payment.id === activePayment.id)) : [], [reconciliation, activePayment, selectedId]);
  const scopedInvoiceRows = invoiceScopeIds ? relatedInvoiceRows.filter((row) => invoiceScopeIds.includes(row.invoice.id)) : relatedInvoiceRows;
  const relatedAdjustmentCount = activePayment ? dataset.payments.filter((payment) => linkedAdjustment(payment, activePayment) && payment.id !== activePayment.id).length : 0;
  const aiScopeError = !activePayment || !isEligibleReceipt(activePayment) ? "Choose a completed incoming receipt before investigating its note." : activeIsManual ? "This receipt was selected manually without a matching rule. Review the source and record your reason for the association." : scopedInvoiceRows.length > 20 ? `${relatedInvoiceRows.length} candidate invoices are available. Choose up to 20 in the AI evidence review. This does not reject or remove other matches.` : relatedAdjustmentCount > 19 ? `${relatedAdjustmentCount} related adjustments are available. AI supports one receipt and at most 19 adjustments. Review this case manually; no adjustments will be silently omitted.` : "";
  const contextInvoiceRows = aiScopeError ? [] : scopedInvoiceRows;
  const filteredReceiptCandidates = reviewableCandidates.filter(({ payment }) => `${payment.id} ${payment.providerId} ${payment.memo} ${payment.invoiceId ?? ""}`.toLowerCase().includes(receiptQuery.trim().toLowerCase()));
  const receiptPageCount = Math.max(1, Math.ceil(filteredReceiptCandidates.length / 20));
  const currentReceiptPage = Math.min(receiptPage, receiptPageCount - 1);
  const pagedReceiptCandidates = filteredReceiptCandidates.slice(currentReceiptPage * 20, (currentReceiptPage + 1) * 20);
  const retainedAnalysis = [...decisionEvidence].reverse().find((evidence) => evidence.invoiceId === selectedId && evidence.paymentId === activePaymentId);
  const displayedAnalysis = ai ?? retainedAnalysis?.investigation ?? null;
  const analysisIsHistorical = !ai && Boolean(retainedAnalysis);
  const recordedScope = useMemo(() => retainedAnalysis ? retainedInvestigationScope(retainedAnalysis, dataset) : null, [retainedAnalysis, dataset]);
  const interpretationScope = analysisIsHistorical ? recordedScope : ai ? { included: scopedInvoiceRows.length, total: relatedInvoiceRows.length, excluded: relatedInvoiceRows.length - scopedInvoiceRows.length, payments: 1 + relatedAdjustmentCount } : null;
  const appliedDecisions = review.allocations.filter((allocation) => allocation.invoiceId === selectedId);
  const appliedRejections = review.rejections.filter((rejection) => rejection.invoiceId === selectedId);
  const visibleFindings = useMemo(() => {
    const term = query.trim().toLowerCase();
    return desk.findings.filter((finding) => (findingKind === "all" || finding.kind === findingKind) && (!term || `${finding.title} ${finding.description} ${finding.invoiceIds.join(" ")} ${finding.paymentIds.join(" ")} ${finding.kind}`.toLowerCase().includes(term)));
  }, [desk.findings, findingKind, query]);
  const visibleRows = reconciliation.rows.filter((row) => {
    const matchesQuery = `${row.invoice.id} ${row.invoice.customer} ${row.invoice.customerKey} ${row.invoice.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
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
  const approvalMatchesProvider = configuration.ai && Boolean(configuration.aiProvider) && excerptApproved && approvedProvider === configuration.aiProvider;
  const importProfile = useMemo(() => importKind === "payments" && headers.length ? getPaymentImportProfile(csvText, mapping) : null, [importKind, headers, csvText, mapping]);
  const inspectedPayment = modal === "event" ? dataset.payments.find((payment) => payment.id === inspectedPaymentId) ?? null : null;
  const inspectedLinks = inspectedPayment ? dataset.payments.filter((payment) => payment.id !== inspectedPayment.id && ((payment.referenceType === "TXN" && payment.referenceId?.trim() === inspectedPayment.providerId) || (inspectedPayment.referenceType === "TXN" && inspectedPayment.referenceId?.trim() === payment.providerId))) : [];
  const inspectedLinkPageCount = Math.max(1, Math.ceil(inspectedLinks.length / PAGE_SIZE));
  const currentInspectedLinkPage = Math.min(inspectedLinkPage, inspectedLinkPageCount - 1);
  const pagedInspectedLinks = inspectedLinks.slice(currentInspectedLinkPage * PAGE_SIZE, (currentInspectedLinkPage + 1) * PAGE_SIZE);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modal) {
      if (!dialog.open) {
        dialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
      dialog.scrollTop = 0;
      if (modal === "ai-review") {
        const scope = dialog.querySelector<HTMLDetailsElement>(".scope-selection-required");
        if (scope) scope.open = true;
      }
      dialogTitleRef.current?.focus({ preventScroll: true });
    } else if (dialog.open) {
      dialog.close();
      const trigger = dialogTriggerRef.current;
      if (trigger?.isConnected && !trigger.matches(":disabled")) trigger.focus({ preventScroll: true });
      else (aiCancelRef.current ?? caseHeadingRef.current)?.focus({ preventScroll: true });
      dialogTriggerRef.current = null;
    }
  }, [modal]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    invalidateAi();
    setExcerptApproved(false);
    setApprovedProvider(null);
  }, [configuration.ai, configuration.aiProvider]);

  useEffect(() => {
    void refreshPaypalConnection();
    return () => { aiRequest.current?.controller.abort(); paypalRequest.current?.controller.abort(); paypalConnectionRequest.current?.controller.abort(); };
  }, []);

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
    setPaypalApplying(false);
    paypalConnectionRequest.current?.controller.abort();
    paypalConnectionRequest.current = null;
    setPaypalConnectionBusy(null);
    setSandboxClientId("");
    setSandboxClientSecret("");
    setInspectedPaymentId(null);
    setInspectedLinkPage(0);
    setModal(null);
  }

  function chooseCase(id: string, openDetail = true, preferredPaymentId?: string) {
    const current = snapshot.current;
    if (current.selectedId === id && (!preferredPaymentId || current.excerptPaymentId === preferredPaymentId)) {
      selectionOrigin.current = id;
      if (openDetail) {
        setMobileDetail(true);
        requestAnimationFrame(() => caseHeadingRef.current?.focus());
      }
      return;
    }
    invalidateAi();
    const currentReconciliation = current.dataset === dataset && current.review === review ? reconciliation : reconcile(current.dataset, current.review);
    const row = currentReconciliation.rows.find((result) => result.invoice.id === id);
    snapshot.current = { ...current, selectedId: id, excerpt: "", invoiceContexts: {}, invoiceScopeIds: undefined };
    setSelectedId(id);
    setManualReceiptIds([]);
    const referenced = row?.candidatePayments.filter((candidate) => candidate.eligible && candidate.match === "reference" && !row.confirmedPayments.some((payment) => payment.id === candidate.payment.id)).map((candidate) => candidate.payment.id) ?? [];
    const firstEligible = row?.candidatePayments.find((candidate) => candidate.eligible && !row.confirmedPayments.some((payment) => payment.id === candidate.payment.id))?.payment.id;
    const preferred = preferredPaymentId && (row?.candidatePayments.some((candidate) => candidate.payment.id === preferredPaymentId) || row?.confirmedPayments.some((payment) => payment.id === preferredPaymentId)) ? preferredPaymentId : null;
    const owner = preferred ?? firstEligible ?? row?.confirmedPayments[0]?.id ?? row?.candidatePayments[0]?.payment.id ?? null;
    if (current.selectedId !== id || current.excerptPaymentId !== owner) setDecisionNote("");
    snapshot.current = { ...snapshot.current, excerptPaymentId: owner };
    setActivePaymentId(owner);
    setCheckedIds(preferred ? row?.candidatePayments.some((candidate) => candidate.payment.id === preferred && candidate.eligible) && !row.confirmedPayments.some((payment) => payment.id === preferred) ? [preferred] : [] : referenced.length ? referenced : firstEligible ? [firstEligible] : []);
    setExcerpt("");
    setInvoiceContexts({});
    setInvoiceScopeIds(undefined);
    setReceiptQuery("");
    setReceiptPage(0);
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
    setPaypalApplying(false);
    setAppliedPaypalConnectionId(null);
    setPaypalPreview(null);
    const freshReview: ReviewState = { allocations: [], rejections: [], revision: snapshot.current.review.revision + 1 };
    const revision = snapshot.current.dataset.revision + 1;
    const freshDataset = { ...next, revision };
    snapshot.current = { dataset: freshDataset, review: freshReview, selectedId: null, excerpt: "", excerptPaymentId: null, invoiceContexts: {}, invoiceScopeIds: undefined };
    decisionEvidenceRef.current = [];
    setDecisionEvidence([]);
    setDataset(freshDataset);
    setReview(freshReview);
    setSelectedId(null);
    setManualReceiptIds([]);
    setActivePaymentId(null);
    setCheckedIds([]);
    setExcerpt("");
    setInvoiceContexts({});
    setInvoiceScopeIds(undefined);
    setReceiptQuery("");
    setReceiptPage(0);
    setExcerptApproved(false);
    setDecisionError("");
    setView("investigations");
    setFindingKind("all");
    setQuery("");
    setPage(0);
    setMobileDetail(false);
    const firstFinding = buildExceptionDesk(freshDataset, freshReview).findings.find((finding) => finding.invoiceIds.length);
    const firstInvoiceId = firstFinding?.invoiceIds[0] ?? freshDataset.invoices[0]?.id;
    const firstPaymentId = firstFinding?.paymentIds.find((id) => freshDataset.payments.some((payment) => payment.id === id && payment.kind === "receipt")) ?? firstFinding?.paymentIds[0];
    if (firstInvoiceId) chooseCase(firstInvoiceId, false, firstPaymentId);
  }

  function commitReview(next: ReviewState) {
    invalidateAi();
    setDecisionNote("");
    setManualReceiptIds([]);
    setCheckedIds([]);
    const current = snapshot.current;
    const row = reconcile(current.dataset, next).rows.find((result) => result.invoice.id === current.selectedId);
    const payments = [...(row?.candidatePayments.map((candidate) => candidate.payment) ?? []), ...(row?.confirmedPayments ?? [])];
    const owner = payments.find((payment) => payment.id === current.excerptPaymentId)?.id ?? payments[0]?.id ?? null;
    snapshot.current = { ...current, review: next, excerpt: "", excerptPaymentId: owner, invoiceContexts: {}, invoiceScopeIds: undefined };
    setActivePaymentId(owner);
    setExcerpt("");
    setInvoiceContexts({});
    setInvoiceScopeIds(undefined);
    setReview(next);
    setExcerptApproved(false);
    setDecisionError("");
  }

  function loadSample() {
    commitDataset(createSampleDataset());
    closeModal();
    setToast("Sample ledger loaded. Review matches before confirming.");
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

  function changeInvoiceContext(id: string, value: string) {
    invalidateAi();
    const next = { ...snapshot.current.invoiceContexts, [id]: value };
    snapshot.current = { ...snapshot.current, invoiceContexts: next };
    setInvoiceContexts(next);
    setExcerptApproved(false);
  }

  function changeInvestigationScope(ids: string[] | undefined) {
    invalidateAi();
    const current = snapshot.current;
    const contexts = Object.fromEntries(Object.entries(current.invoiceContexts).filter(([id]) => !ids || ids.includes(id)));
    snapshot.current = { ...current, invoiceScopeIds: ids, invoiceContexts: contexts };
    setInvoiceScopeIds(ids);
    setInvoiceContexts(contexts);
    setExcerptApproved(false);
  }

  function prepareEvidence() {
    if (!activePayment || aiScopeError) return;
    invalidateAi();
    const contexts = Object.fromEntries(contextInvoiceRows.map(({ invoice }) => [invoice.id, invoice.description ?? ""]));
    const memo = activePayment.memo.slice(0, 1200);
    snapshot.current = { ...snapshot.current, excerpt: memo, invoiceContexts: contexts };
    setExcerpt(memo);
    setInvoiceContexts(contexts);
    setExcerptApproved(false);
  }

  function openInvestigation() {
    if (!excerpt.trim()) prepareEvidence();
    setModal("ai-review");
  }

  function openComparison() {
    const comparison = document.getElementById("candidate-invoices");
    comparison?.scrollIntoView({ block: "start" });
    comparison?.focus({ preventScroll: true });
  }

  function chooseReceiptOwner(id: string) {
    if (snapshot.current.excerptPaymentId !== id) setDecisionNote("");
    invalidateAi();
    snapshot.current = { ...snapshot.current, excerpt: "", excerptPaymentId: id, invoiceContexts: {}, invoiceScopeIds: undefined };
    setActivePaymentId(id);
    setExcerpt("");
    setInvoiceContexts({});
    setInvoiceScopeIds(undefined);
    setExcerptApproved(false);
    setDecisionError("");
  }

  function selectManualReceipt(id: string) {
    const current = snapshot.current;
    const invoice = current.dataset.invoices.find((item) => item.id === current.selectedId);
    const currentReconciliation = current.dataset === dataset && current.review === review ? reconciliation : reconcile(current.dataset, current.review);
    const payment = currentReconciliation.unallocatedPayments.find((item) => item.id === id);
    if (!invoice || !payment || (payment.invoiceId?.trim() && payment.invoiceId.trim() !== invoice.id)) {
      setDecisionError("This receipt is no longer available for the selected invoice.");
      closeModal();
      return;
    }
    setManualReceiptIds((ids) => [...new Set([...ids, id])]);
    setCheckedIds([id]);
    setDecisionNote("");
    chooseReceiptOwner(id);
    closeModal();
    requestAnimationFrame(() => document.getElementById("association-decision")?.scrollIntoView({ block: "start" }));
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
    setPaypalApplying(false);
    setPaypalPreview(null);
    setAppliedPaypalConnectionId(null);
    setImportBusy(false);
    setCsvPreview(null);
    setCsvText("");
    setCsvFilename("");
    setHeaders([]);
    setMapping({});
    setImportError("");
    setWorkspaceReadBusy(false);
    const savedSelection = restored.dataset.invoices.some((invoice) => invoice.id === restored.selectedInvoiceId) ? restored.selectedInvoiceId : restored.dataset.invoices[0]?.id ?? null;
    snapshot.current = { dataset: restored.dataset, review: restored.review, selectedId: null, excerpt: "", excerptPaymentId: null, invoiceContexts: {}, invoiceScopeIds: undefined };
    decisionEvidenceRef.current = [];
    setDecisionEvidence([]);
    setDataset(restored.dataset);
    setReview(restored.review);
    setManualReceiptIds([]);
    setSelectedId(null);
    setActivePaymentId(null);
    setCheckedIds([]);
    setExcerpt("");
    setInvoiceContexts({});
    setInvoiceScopeIds(undefined);
    setReceiptQuery("");
    setReceiptPage(0);
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
    const dates = csvPreview.result.records.map((row) => "dueDate" in row ? row.dueDate : row.timestamp).sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b));
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
    setPaypalApplying(false);
    setPaypalPreview(null);
    setPaypalError("");
  }

  function updatePaypalConnection(status: PayPalConnectionStatus) {
    if (paypalConnectionRef.current.connectionId !== status.connectionId) resetPaypalPreview();
    paypalConnectionRef.current = status;
    setPaypalConnection(status);
    setPaypalStatusLoaded(true);
  }

  async function refreshPaypalConnection() {
    paypalConnectionRequest.current?.controller.abort();
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    paypalConnectionRequest.current = request;
    setPaypalConnectionBusy("status");
    setPaypalConnectionError("");
    try {
      const status = await sendPaypalConnection({ operation: "status" }, request.controller.signal);
      if (paypalConnectionRequest.current?.id === request.id && !request.controller.signal.aborted) updatePaypalConnection(status);
    } catch (error) {
      if (paypalConnectionRequest.current?.id === request.id && !request.controller.signal.aborted) {
        setPaypalStatusLoaded(false);
        setPaypalConnectionError(error instanceof Error ? error.message : "The sandbox status could not be checked.");
      }
    } finally {
      if (paypalConnectionRequest.current?.id === request.id) { paypalConnectionRequest.current = null; setPaypalConnectionBusy(null); }
    }
  }

  function openPaypal() {
    resetPaypalPreview();
    setSandboxClientId("");
    setSandboxClientSecret("");
    setModal("paypal");
    void refreshPaypalConnection();
  }

  async function changePaypalConnection(operation: "connect" | "disconnect") {
    const parsed = paypalConnectionRequestSchema.safeParse(operation === "connect" ? { operation, clientId: sandboxClientId, clientSecret: sandboxClientSecret } : { operation });
    if (!parsed.success) { setPaypalConnectionError("Enter the sandbox app’s Client ID and Secret. Do not enter your PayPal account password."); return; }
    paypalConnectionRequest.current?.controller.abort();
    resetPaypalPreview();
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    paypalConnectionRequest.current = request;
    setPaypalConnectionBusy(operation);
    setPaypalConnectionError("");
    setSandboxClientId("");
    setSandboxClientSecret("");
    try {
      const status = await sendPaypalConnection(parsed.data, request.controller.signal);
      if (paypalConnectionRequest.current?.id !== request.id || request.controller.signal.aborted) return;
      updatePaypalConnection(status);
      setToast(operation === "connect" ? "Sandbox app authenticated. Fetch a record to verify merchant access." : "Sandbox disconnected. Loaded records and decisions were kept.");
    } catch (error) {
      if (paypalConnectionRequest.current?.id === request.id && !request.controller.signal.aborted) setPaypalConnectionError(error instanceof Error ? error.message : "The sandbox connection could not be changed.");
    } finally {
      if (paypalConnectionRequest.current?.id === request.id) { paypalConnectionRequest.current = null; setPaypalConnectionBusy(null); }
    }
  }

  async function fetchPaypal() {
    paypalRequest.current?.controller.abort();
    setPaypalError("");
    setPaypalPreview(null);
    const connectionId = paypalConnectionRef.current.connectionId;
    if (!paypalStatusLoaded || !connectionId) { setPaypalError("Connect a sandbox app before requesting merchant records."); return; }
    const parsed = paypalRequestSchema.safeParse(paypalOperation === "capture" ? { operation: "capture", captureId: captureId.trim(), connectionId } : { operation: "transactions", startDate: startDate ? `${startDate}T00:00:00.000Z` : "", endDate: endDate ? `${endDate}T23:59:59.000Z` : "", connectionId });
    if (!parsed.success) { setPaypalError("Enter a valid capture ID, or both dates for a reporting window of at most 31 days."); return; }
    const request = { id: crypto.randomUUID(), controller: new AbortController(), revision: snapshot.current.dataset.revision };
    paypalRequest.current = request;
    setPaypalBusy(true);
    try {
      const response = await fetch("/api/paypal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data), signal: request.controller.signal });
      const body: unknown = await response.json();
      if (paypalRequest.current?.id !== request.id || snapshot.current.dataset.revision !== request.revision || paypalConnectionRef.current.connectionId !== connectionId) return;
      if (!response.ok) throw new Error(apiError(body, "The sandbox request failed. Your current payment data has been kept."));
      const result = paypalResponseSchema.safeParse(body);
      if (!result.success) throw new Error("The sandbox response did not pass validation. Your current payment data has been kept.");
      if (result.data.connectionId !== connectionId) throw new Error("The sandbox connection changed. Fetch a new preview before applying records.");
      updatePaypalConnection({ ...paypalConnectionRef.current, authenticated: true });
      setPaypalPreview({ ...result.data, revision: request.revision });
    } catch (error) {
      if (paypalRequest.current?.id === request.id && !request.controller.signal.aborted) setPaypalError(error instanceof Error ? error.message : "The PayPal sandbox could not be reached.");
    } finally {
      if (paypalRequest.current?.id === request.id) { setPaypalBusy(false); paypalRequest.current = null; }
    }
  }

  async function applyPaypal() {
    const preview = paypalPreview;
    if (!preview || preview.revision !== snapshot.current.dataset.revision || preview.connectionId !== paypalConnectionRef.current.connectionId) { setPaypalError("This preview is stale. Fetch the source again before replacing payment data."); return; }
    paypalRequest.current?.controller.abort();
    const request = { id: crypto.randomUUID(), controller: new AbortController(), revision: snapshot.current.dataset.revision };
    paypalRequest.current = request;
    setPaypalBusy(true);
    setPaypalApplying(true);
    setPaypalError("");
    try {
      const status = await sendPaypalConnection({ operation: "status" }, request.controller.signal);
      if (paypalRequest.current?.id !== request.id || request.controller.signal.aborted || snapshot.current.dataset.revision !== request.revision) return;
      if (!status.connected || status.connectionId !== preview.connectionId) {
        updatePaypalConnection(status);
        setPaypalError("The sandbox connection changed. Fetch a new preview before applying records.");
        return;
      }
      updatePaypalConnection(status);
      commitDataset({ ...snapshot.current.dataset, payments: preview.payments, paymentSource: preview.source });
      setAppliedPaypalConnectionId(preview.connectionId);
      closeModal();
      setToast("Sandbox records applied. Invoices were kept; prior review decisions and AI were cleared.");
    } catch (error) {
      if (paypalRequest.current?.id === request.id && !request.controller.signal.aborted) setPaypalError(error instanceof Error ? error.message : "The connection could not be checked. Current records were kept.");
    } finally {
      if (paypalRequest.current?.id === request.id) { paypalRequest.current = null; setPaypalBusy(false); setPaypalApplying(false); }
    }
  }

  async function investigate() {
    const current = snapshot.current;
    const expectedProvider = configuration.aiProvider;
    if (!expectedProvider || !approvalMatchesProvider || !current.selectedId || !current.excerpt.trim()) return;
    invalidateAi();
    const id = crypto.randomUUID();
    try {
      const packet = buildInvestigationRequest(current.dataset, current.review, current.selectedId, current.excerpt, id, current.excerptPaymentId ?? undefined, current.invoiceContexts, current.invoiceScopeIds);
      const request = { id, fingerprint: packet.fingerprint, revision: current.dataset.revision, controller: new AbortController() };
      aiRequest.current = request;
      setAiBusy(true);
      if (modal === "ai-review") closeModal();
      try {
        const response = await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...packet, expectedProvider }), signal: request.controller.signal });
        const body: unknown = await response.json();
        const latest = snapshot.current;
        if (aiRequest.current?.id !== id || !latest.selectedId || caseFingerprint(latest.dataset, latest.review, latest.selectedId, latest.excerpt, latest.excerptPaymentId ?? undefined, latest.invoiceContexts, latest.invoiceScopeIds) !== request.fingerprint) return;
        if (response.status === 409) { setExcerptApproved(false); setApprovedProvider(null); }
        if (!response.ok) throw new Error(apiError(body, "The investigation failed. Your evidence and decisions have been kept."));
        const result = investigationResponseSchema.safeParse(body);
        if (!result.success || result.data.requestId !== id || result.data.fingerprint !== request.fingerprint) throw new Error("The investigation response did not pass validation. No proposal was applied.");
        if (result.data.provider !== expectedProvider) {
          setExcerptApproved(false);
          setApprovedProvider(null);
          throw new Error("The response did not match the approved AI destination. No proposal was applied.");
        }
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
      if (action === "confirm" && needsDecisionNote && !decisionNote.trim()) throw new Error("Record the source evidence supporting this manual association before confirming.");
      const next = action === "confirm" ? confirmAllocation(current.dataset, current.review, current.selectedId, checkedIds, decisionNote.trim() || "Confirmed after reviewing source evidence") : action === "undo" ? undoInvoiceReview(current.review, current.selectedId) : checkedIds.reduce((state, id) => rejectAllocation(current.dataset, state, current.selectedId!, id, decisionNote.trim() || "Rejected after reviewing source evidence."), current.review);
      const captured = action === "undo" ? [] : captureDecisionEvidence({ dataset: current.dataset, before: current.review, after: next, invoiceId: current.selectedId, paymentIds: checkedIds, action, investigation: ai, excerpt: current.excerpt, excerptPaymentId: current.excerptPaymentId ?? "", invoiceContexts: current.invoiceContexts, invoiceScopeIds: current.invoiceScopeIds });
      const retained = pruneDecisionEvidence([...decisionEvidenceRef.current, ...captured], current.dataset, next);
      decisionEvidenceRef.current = retained;
      setDecisionEvidence(retained);
      commitReview(next);
      setToast(action === "undo" ? `Review undone for ${current.selectedId}.` : `${checkedIds.length} ${checkedIds.length === 1 ? "match" : "matches"} ${action === "confirm" ? "confirmed" : "rejected"} for ${current.selectedId}.`);
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
    setToast("Review CSV download started.");
  }

  function downloadBrief() {
    const current = snapshot.current;
    if (!current.selectedId) return;
    try {
      const html = buildCaseBrief({ dataset: current.dataset, review: current.review, invoiceId: current.selectedId, decisionEvidence: decisionEvidenceRef.current, draftPaymentIds: manuallySelectedPayments.filter((payment) => checkedIds.includes(payment.id)).map((payment) => payment.id), investigation: ai && current.excerptPaymentId ? { response: ai, excerpt: current.excerpt, excerptPaymentId: current.excerptPaymentId, invoiceContexts: current.invoiceContexts, invoiceScopeIds: current.invoiceScopeIds } : null });
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      const filename = current.selectedId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "case";
      anchor.href = url;
      anchor.download = `paper-ledger-${filename}-evidence.html`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("Evidence brief download started.");
    } catch (error) {
      setToast(`Evidence brief download failed: ${error instanceof Error ? error.message : "the case could not be prepared"}`);
    }
  }

  function downloadReport() {
    const current = snapshot.current;
    try {
      const html = buildReviewReport({ dataset: current.dataset, review: current.review, decisionEvidence: decisionEvidenceRef.current });
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `paper-ledger-review-${new Date().toISOString().slice(0, 10)}.html`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("Review report download started.");
    } catch (error) {
      setToast(`Review report download failed: ${error instanceof Error ? error.message : "the report could not be prepared"}`);
    }
  }

  function chooseComparisonInvoice(id: string) {
    const current = snapshot.current;
    if (id === current.selectedId) { chooseCase(id); return; }
    const currentReconciliation = current.dataset === dataset && current.review === review ? reconciliation : reconcile(current.dataset, current.review);
    const row = currentReconciliation.rows.find((result) => result.invoice.id === id);
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
    if (!snapshot.current.dataset.payments.some((payment) => payment.id === id)) return;
    setInspectedPaymentId(id);
    setInspectedLinkPage(0);
    setModal("event");
  }

  function inspectRelatedInvoice(id: string) {
    const paymentId = inspectedPayment?.id;
    closeModal();
    chooseCase(id, true, paymentId);
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
  const activeReviewRecorded = [...appliedDecisions, ...appliedRejections].some((decision) => decision.paymentId === activePayment?.id);

  const interpretationPanel = displayedAnalysis ? <section className={`reference-result${analysisIsHistorical ? " reference-historical" : ""}`} aria-label={analysisIsHistorical ? "AI evidence retained with decision" : "AI reference interpretation"} aria-live="polite">
                  <div className="ai-result-heading"><span>{analysisIsHistorical ? "Pre-decision AI evidence" : "Reference interpretation"}</span><span>{displayedAnalysis.provider === "codex" ? "Codex" : "Gemini"}</span></div>
                  <h4 className="reference-verdict">{displayedAnalysis.proposal.category === "reference_interpretation" ? `${analysisIsHistorical ? "Suggested" : "Suggests"} ${displayedAnalysis.proposal.invoiceId}` : displayedAnalysis.proposal.category === "ambiguous" ? analysisIsHistorical ? "Evidence was ambiguous" : "Evidence is ambiguous" : analysisIsHistorical ? "No supported association was found" : "No supported association"}</h4>
                  {displayedAnalysis.proposal.quote && <div className="reference-evidence"><span className="reference-source-label">Quoted remittance</span><blockquote>{displayedAnalysis.proposal.quote}</blockquote></div>}
                  {displayedAnalysis.proposal.contextQuote && <div className="reference-context"><span className="reference-source-label">Approved invoice context · {displayedAnalysis.proposal.invoiceId}</span><blockquote>{displayedAnalysis.proposal.contextQuote}</blockquote></div>}
                  <p className="small-note">{analysisIsHistorical ? "Recorded before your decision." : "Check the quoted evidence before confirming."}</p>
                  {interpretationScope && <p className="small-note">{analysisIsHistorical ? "Original evidence" : "Evidence supplied"}: {interpretationScope.included} of {interpretationScope.total} invoice candidates · {interpretationScope.payments} payment {interpretationScope.payments === 1 ? "record" : "records"}</p>}
                  {interpretationScope && interpretationScope.excluded > 0 && <p className="scope-result-notice">{interpretationScope.excluded} other candidates were outside this investigation. It did not examine or reject them.</p>}
                  <details className="reference-details"><summary>Sources & deterministic checks</summary>
                    <div className="citations">{displayedAnalysis.proposal.evidenceIds.map((id) => <span className="citation" key={id}>{id}</span>)}</div>
                    {!analysisIsHistorical && <p className="ai-next-step">{NEXT_STEPS[displayedAnalysis.proposal.category]}</p>}
                    {displayedAnalysis.observations.length > 0 && <ul className="ai-observations">{displayedAnalysis.observations.map((observation) => <li key={observation.id}>{observation.text}</li>)}</ul>}
                    <p className="small-note">{displayedAnalysis.model} · {reviewTimeLabel(displayedAnalysis.generatedAt)}</p>
                  </details>
                  {!analysisIsHistorical && displayedAnalysis.proposal.invoiceId && displayedAnalysis.proposal.invoiceId !== selectedId && <button onClick={() => chooseComparisonInvoice(displayedAnalysis.proposal.invoiceId!)}>Review suggested {displayedAnalysis.proposal.invoiceId}</button>}
                </section> : null;

  return <div className="app">
    <header className="workspace-header"><a className="brand" href="#workspace">Paper Ledger</a><nav aria-label="Workspace navigation"><button className={view === "investigations" ? "active" : ""} aria-pressed={view === "investigations"} onClick={() => selectView("investigations")}>Investigations{loaded && <span className="nav-count">{desk.findings.length}</span>}</button><button className={view !== "receipts" && view !== "investigations" ? "active" : ""} aria-pressed={view !== "receipts" && view !== "investigations"} onClick={() => selectView("all")}>Invoice ledger{loaded && <span className="nav-count">{dataset.invoices.length}</span>}</button><button className={view === "receipts" ? "active" : ""} aria-pressed={view === "receipts"} onClick={() => selectView("receipts")}>Receipts{loaded && <span className="nav-count">{unallocatedRecords.length}</span>}</button><button aria-haspopup="dialog" onClick={() => setModal("sources")}>Sources</button></nav><div className="heading-actions"><button onClick={openWorkspaceFiles}><Icon name="source" />Workspace</button><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}><Icon name="upload" />Import files</button><button onClick={openPaypal}>PayPal sandbox</button>{loaded && <><button onClick={downloadReview}><Icon name="download" />Export CSV</button><button className="primary" onClick={downloadReport}><Icon name="download" />Review report</button></>}</div></header>
    <main className="shell" id="workspace"><h1 className="sr-only">{view === "investigations" ? "Investigations" : view === "receipts" ? "Receipts" : "Invoice ledger"}</h1><div className="workbench-heading"><span>{dataset.invoices.length} {dataset.invoices.length === 1 ? "invoice" : "invoices"} · {dataset.payments.length} payment {dataset.payments.length === 1 ? "record" : "records"} · USD{dataset.paymentSource?.rangeStart ? ` · Observed ${dateLabel(dataset.paymentSource.rangeStart)}${dataset.paymentSource.rangeEnd && dataset.paymentSource.rangeEnd !== dataset.paymentSource.rangeStart ? `–${dateLabel(dataset.paymentSource.rangeEnd)}` : ""}` : ""}</span><button className="source-badge" onClick={() => setModal("sources")}>{dataset.paymentSource ? <>{sourceLabel(dataset.paymentSource)} · {dataset.paymentSource.kind === "sample" ? "synthetic / unverified" : dataset.paymentSource.providerVerified ? "returned sandbox records only" : "unverified"}</> : "No payments loaded"}<Icon name="arrow" /></button></div>
      {loaded && <ReviewOverview dataset={dataset} review={review} reconciliation={reconciliation} desk={desk} />}
      {!loaded ? <section className="empty-workspace" aria-labelledby="empty-title"><p className="empty-kicker">PAYMENT INVESTIGATION WORKSPACE</p><h2 id="empty-title">Know which invoice a payment actually covers.</h2><p>Follow the receipt, compare the evidence, and record a decision you can explain.</p><div className="empty-preview" aria-label="Example ambiguity from the synthetic sample"><div className="empty-preview-receipt"><span>One receipt · PAY701</span><strong>$500.00</strong><q>This is the retainer for the November event, not the remaining October balance.</q></div><div className="empty-preview-options"><div><span>INV-4107 · $500.00</span><strong>November event retainer</strong></div><div><span>INV-4108 · $500.00</span><strong>Remaining October event balance</strong></div></div></div><div className="empty-actions"><button className="primary" onClick={loadSample}>Load sample ledger<Icon name="arrow" /></button><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}>Import your files</button></div><div className="empty-footnote"><Icon name="info" /><span>The sample is synthetic. No PayPal or AI request is made.<br />Save a workspace file to keep records and manual decisions before closing or refreshing this tab.</span></div></section> : <div className={`workspace ${view === "investigations" ? "workbench-view" : "table-view"} ${mobileDetail ? "show-detail" : ""}`}>
        <section className="ledger" aria-label={view === "investigations" ? "Investigation queue" : view === "receipts" ? "Receipt ledger" : "Invoice ledger"}>{view !== "investigations" && <div className="tabs" role="group" aria-label="Ledger views"><button className={`tab ${view === "all" ? "active" : ""}`} aria-pressed={view === "all"} onClick={() => selectView("all")}>All invoices <span>{dataset.invoices.length}</span></button><button className={`tab ${view === "review" ? "active" : ""}`} aria-pressed={view === "review"} onClick={() => selectView("review")}>Needs review <span>{reviewCount}</span></button><button className={`tab ${view === "resolved" ? "active" : ""}`} aria-pressed={view === "resolved"} onClick={() => selectView("resolved")}>Covered <span>{reconciliation.stats.coveredCount}</span></button><button className={`tab receipt-tab ${view === "receipts" ? "active" : ""}`} aria-pressed={view === "receipts"} onClick={() => selectView("receipts")}>Unallocated <span>{unallocatedRecords.length}</span></button></div>}
          {view === "investigations" ? <InvestigationDesk dataset={dataset} desk={desk} findings={pagedFindings} totalFindings={totalVisible} selectedId={selectedId} selectedPaymentId={activePaymentId} query={query} kind={findingKind} onKind={(kind) => { setFindingKind(kind); setPage(0); }} searchRef={ledgerSearchRef} onQuery={(value) => { setQuery(value); setPage(0); }} onInvoice={(id, paymentId) => chooseCase(id, true, paymentId)} onReceipt={inspectReceipt} onLedger={() => selectView("all")} invoiceButtonRef={(id, element) => { if (element) rowButtons.current.set(id, element); else rowButtons.current.delete(id); }} /> : <><div className="table-tools"><label className="search"><span className="search-label">Search {view === "receipts" ? "receipts" : "invoices"}</span><Icon name="search" /><input ref={ledgerSearchRef} type="search" placeholder={view === "receipts" ? "Receipt or reference" : "Invoice or customer"} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label><span className="table-note">Confirmed allocations only</span></div>
          <div className="table-scroll">{view !== "receipts" ? <table><caption className="sr-only">Invoices and confirmed allocations. Select an invoice to review its evidence.</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col" className="number">Amount</th><th scope="col" className="number">Confirmed</th><th scope="col">Review state</th></tr></thead><tbody>{pagedRows.map((row) => <tr key={row.invoice.id} className={selectedId === row.invoice.id ? "selected" : ""}><td><button ref={(element) => { if (element) rowButtons.current.set(row.invoice.id, element); else rowButtons.current.delete(row.invoice.id); }} className="row-link invoice-id" onClick={() => chooseCase(row.invoice.id)} aria-label={`Review ${row.invoice.id}, ${row.invoice.customer}`} aria-current={selectedId === row.invoice.id ? "true" : undefined}>{row.invoice.id}</button><span className="cell-sub">Due {dateLabel(row.invoice.dueDate)}</span></td><td className="customer-cell">{row.invoice.customer}<span className="cell-sub">{row.invoice.customerKey || "No customer ID"}</span></td><td className="number">{formatMoney(row.invoice.amountMinor)}</td><td className="number confirmed-cell">{formatMoney(row.confirmedGrossMinor)}</td><td><Status row={row} /></td></tr>)}</tbody></table> : <table><caption className="sr-only">Unallocated payment records, including ineligible and unsupported events.</caption><thead><tr><th scope="col">Receipt / event</th><th scope="col">Reference</th><th scope="col" className="number">Gross</th><th scope="col">Status</th></tr></thead><tbody>{pagedReceipts.map((payment) => <tr key={payment.id}><td><button className="row-link invoice-id" aria-label={`Inspect payment event ${payment.id}`} onClick={() => inspectReceipt(payment.id)}>{payment.id}</button><span className="cell-sub">{payment.eventCode || payment.kind} · {dateLabel(payment.timestamp)}</span></td><td>{payment.invoiceId || "Not supplied"}<span className="cell-sub">{payment.kind}</span></td><td className="number">{formatMoney(payment.grossMinor)}</td><td><span className={`status ${payment.status === "completed" ? "status-neutral" : "status-pending"}`}>{payment.status.replaceAll("_", " ")}</span></td></tr>)}</tbody></table>}</div>
          {totalVisible === 0 && <div className="no-results"><Icon name={view === "receipts" ? "receipt" : "search"} /><h3>{query ? "No records match this search." : view === "resolved" ? "No confirmed coverage yet." : view === "receipts" ? "No unallocated payment records." : "No invoices in this view."}</h3><p>{query ? "Try a different invoice, customer or receipt ID." : !dataset.invoices.length ? "Import your invoice CSV to match against the loaded payment records." : "Suggestions stay separate until you review an association."}</p>{query ? <button onClick={() => setQuery("")}>Clear search</button> : <button onClick={() => selectView("all")}>View all invoices</button>}</div>}
          </>}<div className="ledger-bottom"><span>{totalVisible ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, totalVisible)} of ${totalVisible}` : `0 ${view === "investigations" ? "findings" : "records"}`}<span className="ledger-source-kind"> · {dataset.paymentSource?.kind === "sample" ? "sample" : "loaded"} {view === "investigations" ? "findings" : "records"}</span></span><div className="pagination"><button aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button><span>{currentPage + 1} / {pageCount}</span><button aria-label="Next page" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>→</button></div></div>
          
        </section>
        <aside className="evidence" aria-labelledby="case-title">
          <button className="mobile-back text-button" onClick={goBack}><Icon name="back" />Back to ledger</button>
          {!selected ? <div className="evidence-placeholder"><Icon name="receipt" /><h2 id="case-title">Select an invoice</h2><p>Its source records, exact arithmetic and review actions will appear here.</p></div> : <>
            <div className="case-heading">
              <div className="case-heading-main">
                <div className="case-header"><span>{selected.invoice.id} · Due {dateLabel(selected.invoice.dueDate)}<span className="case-status-inline"> · {selected.status === "needs-review" && selected.candidatePayments.some((candidate) => candidate.match !== "reference") ? "Unconfirmed association" : LABELS[selected.status]}</span></span><span className="case-index">{reconciliation.rows.findIndex((row) => row.invoice.id === selectedId) + 1} / {dataset.invoices.length}</span></div>
                <h2 id="case-title" ref={caseHeadingRef} tabIndex={-1}>{selected.invoice.customer}</h2>
                {selected.invoice.description && <p className="case-context">{selected.invoice.description}</p>}
                <a className="review-jump" href="#association-decision">Review decision ↓</a>
              </div>
              <div className="case-heading-summary">
                <div className="case-state"><span>Invoice amount <strong>{formatMoney(selected.invoice.amountMinor)}</strong></span><span>Confirmed gross <b>{formatMoney(selected.confirmedGrossMinor)}</b></span></div>
                <div className="case-export"><button onClick={downloadBrief}><Icon name="download" />Download evidence brief</button>{decisionEvidence.some((evidence) => evidence.invoiceId === selectedId) && <p>Includes the pre-decision AI evidence and your later decision.</p>}</div>
              </div>
            </div>
            <div className="case-actions"><button onClick={openInvestigation} disabled={!activePayment || !isEligibleReceipt(activePayment) || activeIsManual || aiBusy}>Interpret payment note</button><a href="#association-decision">Review decision ↓</a></div>
            <div className="case-body">
              <div className="case-records">
                {activeIsManual && <p className="manual-selection-notice">Manually selected receipt. No matching rule associates it with this invoice; check the original source and record your reason.</p>}
                <CaseComparison dataset={dataset} reconciliation={reconciliation} invoiceId={selected.invoice.id} payment={activePayment} onInvoice={chooseComparisonInvoice} />
                <details className="relationship-trace"><summary>Relationship trace <span>Inspect source connections</span></summary>
              <EvidenceMap key={`${dataset.revision}:${selected.invoice.id}:${activePayment?.id ?? "none"}`} dataset={dataset} reconciliation={reconciliation} invoiceId={selected.invoice.id} payment={activePayment} analysis={displayedAnalysis} historical={analysisIsHistorical} busy={aiBusy} onInvoice={chooseComparisonInvoice} onCompare={openComparison} />
                </details>
                <section className="evidence-section" aria-label="Receipt selection">
                  <div className="section-heading"><h3>Receipts</h3><button className="text-button manual-receipt-button" onClick={() => setModal("receipt")}>Find another receipt</button></div>
                  {!selectedPayments.length ? <p className="small-note">No available receipt supports this invoice within the loaded data. This does not prove it is unpaid.</p> : <>
                    {reviewableCandidates.length > 5 && <div className="receipt-tools"><label className="field-label" htmlFor="receipt-search">Search all {reviewableCandidates.length} candidate receipts</label><input id="receipt-search" type="search" value={receiptQuery} onChange={(event) => { setReceiptQuery(event.target.value); setReceiptPage(0); }} placeholder="Receipt ID, reference or remittance" /></div>}
                    {pagedReceiptCandidates.map((candidate) => <label className={`receipt-choice ${checkedIds.includes(candidate.payment.id) ? "checked" : ""}`} key={candidate.payment.id}><input type="checkbox" checked={checkedIds.includes(candidate.payment.id)} disabled={!candidate.eligible} onChange={(event) => changeReceiptSelection(candidate.payment.id, event.target.checked)} /><span><strong>{candidate.payment.id}</strong><small>{candidate.reason}</small></span><b>{formatMoney(candidate.payment.grossMinor)}</b></label>)}
                    {receiptQuery && !filteredReceiptCandidates.length && <p className="small-note">No candidate receipts match. <button className="text-button" onClick={() => { setReceiptQuery(""); setReceiptPage(0); }}>Clear receipt search</button></p>}
                    {filteredReceiptCandidates.length > 20 && <div className="receipt-pagination"><span>{currentReceiptPage * 20 + 1}–{Math.min((currentReceiptPage + 1) * 20, filteredReceiptCandidates.length)} of {filteredReceiptCandidates.length} candidates</span><div className="pagination"><button aria-label="Previous receipt candidates" disabled={currentReceiptPage === 0} onClick={() => setReceiptPage(currentReceiptPage - 1)}>←</button><span>{currentReceiptPage + 1} / {receiptPageCount}</span><button aria-label="Next receipt candidates" disabled={currentReceiptPage === receiptPageCount - 1} onClick={() => setReceiptPage(currentReceiptPage + 1)}>→</button></div></div>}
                    {manuallySelectedPayments.filter((payment) => !reviewableCandidates.some((candidate) => candidate.payment.id === payment.id)).map((payment) => <label className={`receipt-choice ${checkedIds.includes(payment.id) ? "checked" : ""}`} key={payment.id}><input type="checkbox" checked={checkedIds.includes(payment.id)} onChange={(event) => changeReceiptSelection(payment.id, event.target.checked)} /><span><strong>{payment.id}</strong><small>Manually selected · explain the source evidence before confirming</small></span><b>{formatMoney(payment.grossMinor)}</b></label>)}
                    {selected.confirmedPayments.map((payment) => <button key={payment.id} className="confirmed-receipt" onClick={() => chooseReceiptOwner(payment.id)}><Icon name="check" /><span>{payment.id}<small>Confirmed allocation</small></span><b>{formatMoney(payment.grossMinor)}</b></button>)}
                    {checkedIds.length > 0 && <p className="small-note">Selected for this decision: {checkedIds.join(", ")}. Search and pagination keep your selection.</p>}
                    <details className="source-record-details">
                      <summary>Invoice and original source fields</summary>
                      <dl className="compact-facts"><div><dt>Invoice amount</dt><dd>{formatMoney(selected.invoice.amountMinor)} USD</dd></div><div><dt>Due date</dt><dd>{dateLabel(selected.invoice.dueDate)}</dd></div><div><dt>Invoice source</dt><dd>{sourceLabel(dataset.invoiceSource)} · row {selected.invoice.sourceRow}</dd></div></dl>
                      <SourceFields key={`invoice-${dataset.revision}-${selected.invoice.id}`} title={selected.invoice.raw ? "Original invoice fields" : "Normalized invoice fields"} fields={selected.invoice.raw ?? { invoice_id: selected.invoice.id, customer: selected.invoice.customer, description: selected.invoice.description ?? "", currency: selected.invoice.currency, amount: (selected.invoice.amountMinor / 100).toFixed(2), due_date: selected.invoice.dueDate }} />{activePayment && <SourceFields key={`payment-${dataset.revision}-${activePayment.id}`} title={activePayment.raw ? "Original payment fields" : "Normalized payment fields"} fields={activePayment.raw ?? { provider_id: activePayment.providerId, event_code: activePayment.eventCode, invoice_reference: activePayment.invoiceId ?? "", status: activePayment.status }} />}
                    </details>
                  </>}
                  {selected.reasons.length > 0 && <ul className="case-reasons">{selected.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                </section>
              </div>
              <section className="case-review" aria-label="Review decision">
                <div className="review-heading"><span className="review-phase">Your review</span><h3>{activeReviewRecorded ? "Recorded decision" : "Review this association"}</h3><p>{activePayment ? `${activePayment.id} → ${selected.invoice.id}` : "Choose a receipt to review."}</p></div>
                {!analysisIsHistorical && interpretationPanel}
                <section id="association-decision" className="decision-panel" aria-label="Manual association decision">
                  <h3 className={hasSelectedReview && !activeReviewRecorded ? "" : "sr-only"}>{hasSelectedReview ? "Recorded for this invoice" : "Review association"}</h3>
                  {appliedDecisions.map((decision) => <div className="review-outcome" key={decision.paymentId}><strong>Confirmed · {decision.paymentId} → {decision.invoiceId}</strong><p>{decision.reason}</p><span>Recorded {reviewTimeLabel(decision.confirmedAt)} · review {decision.reviewRevision}</span></div>)}
                  {appliedRejections.map((decision) => <div className="review-outcome review-outcome-rejected" key={decision.paymentId}><strong>Rejected · {decision.paymentId} → {decision.invoiceId}</strong><p>{decision.reason}</p><span>Recorded {reviewTimeLabel(decision.rejectedAt)} · review {decision.reviewRevision}</span></div>)}
                  <div className="decision">
                    {decisionPreview && <ReviewImpact dataset={dataset} review={review} invoiceId={selected.invoice.id} paymentIds={checkedIds} preview={decisionPreview} reconciliation={reconciliation} />}
                    {checkedIds.length > 1 && <p><strong>{checkedIds.join(" + ")}</strong> → <strong>{selected.invoice.id}</strong></p>}
                    {!checkedIds.length && !appliedDecisions.length && <p>Select eligible receipts to confirm or reject an association.</p>}
                    {ai?.proposal.invoiceId && ai.proposal.invoiceId !== selectedId && <p className="inline-error">The AI suggests {ai.proposal.invoiceId}. This decision concerns {selected.invoice.id}; review the difference before confirming.</p>}
                    {checkedIds.length > 0 && <details className="decision-note-details" open={needsDecisionNote || undefined}><summary>{needsDecisionNote ? "Reason for this association" : "Add a decision note"}</summary><div className="decision-note-editor"><label className="field-label" htmlFor="decision-note">Decision note <span>{needsDecisionNote ? "(required)" : "(optional)"}</span></label><textarea id="decision-note" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={4096} rows={3} placeholder="What evidence supports your confirmation or rejection?" aria-describedby="decision-note-help" /><p id="decision-note-help">Saved with your next decision. Not sent to AI. <span>{decisionNote.length} / 4,096</span></p></div></details>}
                    {checkedIds.length > 0 && <div className="decision-buttons"><button className="primary" disabled={!decisionPreview?.valid || (needsDecisionNote && !decisionNote.trim())} onClick={() => decide("confirm")}>Confirm {selected.invoice.id}</button><button onClick={() => decide("reject")}>Reject association</button></div>}
                    {hasSelectedReview && <button className="text-button undo-button" onClick={() => decide("undo")}>↶ Undo this invoice’s review</button>}
                    {decisionError && <p className="inline-error" role="alert">{decisionError}</p>}
                    <p className="decision-note">Records a match in this workspace. No money is moved.</p>
                  </div>
                </section>
                {analysisIsHistorical && interpretationPanel}
                <section className="evidence-section investigation-section">
                  <div className="ai-label"><span><Icon name="search" />Investigate the reference</span><span className={`configuration-tag ${configuration.ai ? "configured" : ""}`}>{configuration.ai ? `${aiProviderLabel} configured` : "Not configured"}</span></div>
                  {!configuration.ai && <p className="configuration-note">Configure a Gemini API key or the local Codex provider on the server, then restart. Manual review remains available.</p>}
                  {aiScopeError ? <p className="evidence-scope" role="status">{aiScopeError}</p> : <p className="evidence-scope">{contextInvoiceRows.length}{invoiceScopeIds && scopedInvoiceRows.length < relatedInvoiceRows.length ? ` of ${relatedInvoiceRows.length}` : ""} candidate {contextInvoiceRows.length === 1 ? "invoice" : "invoices"} · {activePayment ? 1 + relatedAdjustmentCount : 0} payment {relatedAdjustmentCount ? "records" : "record"}. {invoiceScopeIds && scopedInvoiceRows.length < relatedInvoiceRows.length ? "Only the selected invoice scope is shared." : "All related candidates fit in this investigation."}</p>}
                  <button className="review-evidence-button" disabled={!activePayment} onClick={() => setModal("ai-review")}>Review AI evidence<Icon name="arrow" /></button>
                  {aiBusy && <div className="investigate-actions"><span className="small-note" role="status">Investigating…</span><button ref={aiCancelRef} onClick={() => { invalidateAi(); setToast("Investigation cancelled. Your source evidence was kept."); }}>Cancel</button></div>}
                  {aiError && modal !== "ai-review" && <p className="inline-error" role="alert">{aiError}</p>}
                </section>
              </section>
            </div>
          </>}
        </aside>
      </div>}
    </main>
    <dialog ref={dialogRef} className={`workspace-dialog ${modal === "sources" ? "source-dialog" : modal === "ai-review" ? "ai-review-dialog" : ""}`} onCancel={(event) => { event.preventDefault(); closeModal(); }} onClose={() => { if (modal) closeModal(); }} aria-labelledby="dialog-title"><div className="dialog-header"><div><p className="eyebrow">PAPER LEDGER</p><h2 id="dialog-title" ref={dialogTitleRef} tabIndex={-1}>{modal === "import" ? "Import source files" : modal === "paypal" ? "PayPal sandbox" : modal === "sample" ? "Replace with the sample ledger?" : modal === "workspace" ? "Workspace files" : modal === "receipt" ? "Find a receipt" : modal === "event" ? "Payment record" : modal === "ai-review" ? "Review AI evidence" : "Sources & coverage"}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={closeModal}><Icon name="close" /></button></div>
      {modal === "ai-review" && selected && <div className="dialog-body ai-evidence-review">
        <div className="ai-review-scroll excerpt-editor">
          <p className="ai-review-context">{activePayment?.id || "No receipt selected"}<span>→ {selected.invoice.id}</span></p>
          <p className="small-note"><strong>Destination: {configuration.ai ? aiDestination : "No AI provider configured"}.</strong> The remittance and invoice context below are sent exactly as shown, alongside amounts, dates, statuses, source IDs and anonymous customer groups. Names, emails and whole source rows are excluded from structured fields; redact any personal details from the text you approve.</p>
          {!configuration.ai && <p className="configuration-note">Configure a Gemini API key or the local Codex provider on the server, then restart. Manual review remains available.</p>}
          {!activeIsManual && activePayment && isEligibleReceipt(activePayment) && <InvoiceScope invoices={relatedInvoiceRows.map((row) => row.invoice)} caseId={selected.invoice.id} selectedIds={invoiceScopeIds} onChange={changeInvestigationScope} />}
          {aiScopeError && <p className="evidence-scope" role="status">{aiScopeError}</p>}
          <button className="text-button use-memo" disabled={!activePayment || Boolean(aiScopeError)} onClick={prepareEvidence}>Use displayed evidence for review</button>
          <label className="field-label" htmlFor="remittance-excerpt">Redacted remittance excerpt{activePayment ? ` · ${activePayment.id}` : ""}</label>
          <textarea id="remittance-excerpt" maxLength={1200} rows={3} value={excerpt} onChange={(event) => changeExcerpt(event.target.value)} placeholder="Review the receipt’s note and remove personal details." />
          <p className="small-note">{excerpt.length} / 1,200 characters</p>
          <div className="invoice-context-editors"><h4>Invoice context to share</h4><p className="small-note">Optional descriptions help distinguish equal-amount invoices. This is operator-provided context, not a verified PayPal invoice reference. Blank fields are not sent as context.</p>{contextInvoiceRows.map(({ invoice }) => <div className="invoice-context-field" key={invoice.id}><label className="field-label" htmlFor={`context-${invoice.id}`}>Context for {invoice.id}</label><textarea id={`context-${invoice.id}`} rows={2} maxLength={500} value={invoiceContexts[invoice.id] ?? ""} onChange={(event) => changeInvoiceContext(invoice.id, event.target.value)} placeholder="Optional, redacted invoice description or purpose" /><span className="small-note">{(invoiceContexts[invoice.id] ?? "").length} / 500 characters</span></div>)}</div>
        </div>
        <div className="ai-review-approval">
          <label className="consent-label"><input type="checkbox" checked={approvalMatchesProvider} disabled={!configuration.ai || !configuration.aiProvider || !excerpt.trim() || Boolean(aiScopeError)} onChange={(event) => { const approved = event.target.checked && configuration.ai && configuration.aiProvider !== null; if (!approved) invalidateAi(); setApprovedProvider(approved ? configuration.aiProvider : null); setExcerptApproved(approved); }} /><span>{configuration.ai && configuration.aiProvider ? `I reviewed the excerpt, invoice context and case evidence for sending to ${aiDestination}.` : "Configure an AI provider before approving evidence."}</span></label>
          <div className="investigate-actions"><button className="investigate-button" disabled={!approvalMatchesProvider || !excerpt.trim() || !selectedPayments.length || Boolean(aiScopeError) || aiBusy} onClick={investigate}><Icon name="search" />{aiBusy ? "Investigating…" : "Investigate with AI"}</button><button onClick={closeModal}>Close</button></div>
          {aiError && <p className="inline-error" role="alert">{aiError}</p>}
        </div>
      </div>}
      {modal === "import" && <div className="dialog-body"><p className="dialog-intro">Preview and validate one CSV collection before replacing it. USD only · up to 1,000 rows · 2 MB per file.</p><div className="segmented-control" role="group" aria-label="CSV collection"><button className={importKind === "invoices" ? "active" : ""} aria-pressed={importKind === "invoices"} onClick={() => changeImportKind("invoices")}>Invoices</button><button className={importKind === "payments" ? "active" : ""} aria-pressed={importKind === "payments"} onClick={() => changeImportKind("payments")}>Payments</button></div><label className="file-input-label" htmlFor="csv-file"><Icon name="upload" /><span>Choose {importKind === "invoices" ? "invoice" : "payment"} CSV<small>{csvFilename || "Comma-separated file with a header row"}</small></span></label><input type="file" id="csv-file" accept=".csv,text/csv" onChange={readCsv} className="file-input" />{importBusy && <p role="status" className="small-note">Reading file…</p>}{importProfile && <section className="import-profile" aria-label="Detected payment format"><h3>{importProfile.label}</h3><ul>{importProfile.notes.map((note) => <li key={note}>{note}</li>)}</ul></section>}{headers.length > 0 && <><h3 className="dialog-section-title">Column mapping</h3><p className="small-note">Column names are detected automatically. Choose a different column only when the mapping is wrong.</p><div className="mapping-grid">{(importKind === "invoices" ? INVOICE_FIELDS : PAYMENT_FIELDS).map(([key, label]) => <label className="field-label" key={key}>{label}<select value={mapping[key] ?? ""} onChange={(event) => { const value = event.target.value; setMapping((previous) => { const next = { ...previous }; if (value) next[key] = value; else delete next[key]; return next; }); setCsvPreview(null); }}><option value="">Auto-detect / not supplied</option>{headers.map((header) => <option value={header} key={header}>{header}</option>)}</select></label>)}</div><button className="primary preview-button" onClick={previewCsv}>Validate & preview</button></>}{importError && <p className="inline-error" role="alert">{importError}</p>}{csvPreview && <section className="import-preview" aria-live="polite"><h3>{csvPreview.result.issues.length ? "Correction required" : "Ready for replacement preview"}</h3><p>{csvPreview.result.records.length} valid rows · {csvPreview.result.duplicateCount} exact duplicates excluded · {csvPreview.result.issues.length} issues</p>{csvPreview.result.issues.length > 0 ? <><ul className="import-issues">{csvPreview.result.issues.slice(0, 30).map((issue, index) => <li key={`${issue.row}-${index}`}><b>Row {issue.row}:</b> {issue.message}</li>)}</ul>{csvPreview.result.issues.length > 30 && <p className="small-note">Showing 30 issues. Correct the CSV and validate it again.</p>}</> : <><div className="preview-table"><table><thead><tr><th>ID</th><th>{csvPreview.kind === "invoices" ? "Customer" : "Status"}</th><th className="number">{csvPreview.kind === "invoices" ? "Amount" : "Gross"}</th></tr></thead><tbody>{csvPreview.kind === "invoices" ? csvPreview.result.records.slice(0, 5).map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.customer}</td><td className="number">{formatMoney(row.amountMinor)}</td></tr>) : csvPreview.result.records.slice(0, 5).map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.status}</td><td className="number">{formatMoney(row.grossMinor)}</td></tr>)}</tbody></table></div><div className="replacement-notice"><Icon name="info" /><p>This replaces all {csvPreview.kind === "invoices" ? "invoices" : "payment records"}; {csvPreview.kind === "invoices" ? "payment records remain" : "invoices remain"}. Prior confirmations, rejections and AI results will be cleared. File rows remain unverified.</p></div><button className="primary" disabled={!csvPreview.result.records.length} onClick={applyCsv}>Replace {csvPreview.kind === "invoices" ? "invoices" : "payment collection"}</button></>}</section>}<details className="format-guide"><summary>CSV column and money guide</summary><p>Invoices: invoice_id, customer_name, customer_id, description (optional), currency, amount, due_date. Payments: id, provider_id, event_code, kind, status, timestamp, currency, gross, fee, net, invoice_id, customer_key, memo.</p><p>Normalized CSVs use USD decimal amounts without currency symbols, for example 500.00. In PayPal Activity exports, fee signs must be proved by the supplied gross/net bridge. Normalized fee cost is positive for a charge. Signed net = signed gross − fee cost. Missing fee/net stay unknown. Completed incoming receipts are eligible; pending, refunded and unsupported events remain exceptions.</p><p>Synthetic examples: <a href="/samples/invoices.csv" download>invoice CSV</a>, <a href="/samples/payments.csv" download>normalized payments</a>, <a href="/samples/paypal-activity.csv" download>US PayPal Activity CSV</a>. These files are unverified sample records.</p></details></div>}
      {modal === "event" && <div className="dialog-body payment-record-inspector">
        {inspectedPayment ? <>
          <p className="dialog-intro">Read-only source inspection. Opening a record does not select a receipt, change a match or send evidence.</p>
          <CaseComparison dataset={dataset} reconciliation={reconciliation} invoiceId="" payment={inspectedPayment} onInvoice={inspectRelatedInvoice} comparisonId="inspected-payment-comparison" />
          <section className="record-references" aria-label="Payment references"><h3>References & source</h3><dl className="source-facts">
            <div><dt>Invoice reference</dt><dd>{inspectedPayment.invoiceId || "Not supplied"}</dd></div>
            <div><dt>Related transaction</dt><dd>{inspectedPayment.referenceId || "Not supplied"}{inspectedPayment.referenceType ? ` · ${inspectedPayment.referenceType}` : ""}</dd></div>
            <div><dt>Source row</dt><dd>{inspectedPayment.sourceRow}</dd></div>
            <div><dt>Collection</dt><dd>{dataset.paymentSource?.label || "Not supplied"}</dd></div>
            <div><dt>Coverage</dt><dd>{coverageLabel(dataset.paymentSource)}</dd></div>
            <div><dt>Provider verified</dt><dd>{dataset.paymentSource?.kind === "paypal" && dataset.paymentSource.providerVerified ? "Only returned sandbox observations" : "No"}</dd></div>
          </dl></section>
          {inspectedLinks.length > 0 && <section className="record-links" aria-label="Transaction-linked records"><div className="record-links-heading"><h3>Linked source records</h3><span>{inspectedLinks.length} {inspectedLinks.length === 1 ? "record" : "records"}</span></div><p className="small-note">Linked by an explicit TXN reference to a provider transaction ID. These are source relationships, not invoice allocations.</p><ul>{pagedInspectedLinks.map((payment) => <li key={payment.id}><button onClick={() => inspectReceipt(payment.id)} aria-label={`Inspect linked payment event ${payment.id}`}>{payment.id}</button><span>{payment.kind} · {payment.status.replaceAll("_", " ")}</span><strong>{formatMoney(payment.grossMinor)}</strong></li>)}</ul>{inspectedLinkPageCount > 1 && <div className="record-links-pagination"><span>{currentInspectedLinkPage * PAGE_SIZE + 1}–{Math.min((currentInspectedLinkPage + 1) * PAGE_SIZE, inspectedLinks.length)} of {inspectedLinks.length}</span><button aria-label="Previous linked source records" disabled={currentInspectedLinkPage === 0} onClick={() => setInspectedLinkPage(currentInspectedLinkPage - 1)}>Previous</button><button aria-label="Next linked source records" disabled={currentInspectedLinkPage + 1 >= inspectedLinkPageCount} onClick={() => setInspectedLinkPage(currentInspectedLinkPage + 1)}>Next</button></div>}</section>}
          <SourceFields key={`inspected-${dataset.revision}-${inspectedPayment.id}`} title={inspectedPayment.raw ? "Original payment fields" : "Normalized payment fields"} fields={inspectedPayment.raw ?? { provider_id: inspectedPayment.providerId, event_code: inspectedPayment.eventCode, kind: inspectedPayment.kind, status: inspectedPayment.status, timestamp: inspectedPayment.timestamp, invoice_reference: inspectedPayment.invoiceId ?? "", related_id: inspectedPayment.referenceId ?? "", related_id_type: inspectedPayment.referenceType ?? "" }} />
          <div className="dialog-footer"><button onClick={() => { closeModal(); selectView("all"); }}>Open invoice ledger</button><button className="primary" onClick={closeModal}>Done inspecting</button></div>
        </> : <p className="small-note">This record is no longer in the active payment collection. Close this view and inspect the current source.</p>}
      </div>}
      {modal === "paypal" && <div className="dialog-body">
        <p className="dialog-intro">Connect your own sandbox app, then inspect an existing capture or a reporting window. This workspace reads records; it does not create payments.</p>
        <section className="paypal-connection" aria-label="Sandbox connection">
          <div className="paypal-connection-heading"><div><h3>{!paypalStatusLoaded ? "Checking sandbox connection" : paypalConnection.authenticated ? "Sandbox app authenticated" : paypalConnection.connected ? "Sandbox app configured" : "Connect a sandbox app"}</h3><p>{paypalConnection.connected ? paypalConnection.source === "environment" ? "Using server-configured credentials" : "Credentials held in this local server’s memory" : "Your invoice and receipt files remain usable without a connection."}</p></div><button className="text-button" disabled={Boolean(paypalConnectionBusy)} onClick={() => void refreshPaypalConnection()}>Refresh status</button></div>
          {paypalConnection.connected && <p className="small-note">{paypalConnection.authenticated ? "Authentication does not verify any loaded records. Capture access and reporting permissions are checked when you fetch evidence." : "The app has credentials; authentication and record access still need verification."}</p>}
          {paypalConnectionError && <p className="inline-error" role="alert">{paypalConnectionError}</p>}
          <details className="paypal-credentials" open={!paypalConnection.connected || undefined}><summary>{paypalConnection.connected ? "Use another sandbox app" : "Enter sandbox app credentials"}</summary>
            <form onSubmit={(event) => { event.preventDefault(); void changePaypalConnection("connect"); }}>
              <p className="small-note">Use the app’s Client ID and Secret from <a href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">PayPal Developer → Apps & Credentials → Sandbox</a>. These are different from your PayPal email and password.</p>
              <label className="field-label" htmlFor="sandbox-client-id">Sandbox Client ID<input id="sandbox-client-id" value={sandboxClientId} onChange={(event) => setSandboxClientId(event.target.value)} autoComplete="off" spellCheck={false} maxLength={1024} disabled={Boolean(paypalConnectionBusy)} /></label>
              <label className="field-label" htmlFor="sandbox-client-secret">Sandbox Secret<input id="sandbox-client-secret" type="password" value={sandboxClientSecret} onChange={(event) => setSandboxClientSecret(event.target.value)} autoComplete="off" spellCheck={false} maxLength={2048} disabled={Boolean(paypalConnectionBusy)} /></label>
              <p className="small-note">Sent only to this local server and PayPal’s sandbox for authentication. Session credentials are kept in process memory, never in workspace files or browser storage, and are removed on disconnect or server restart. Do not enter your PayPal account password.</p>
              <button className="primary" type="submit" disabled={!sandboxClientId.trim() || !sandboxClientSecret.trim() || Boolean(paypalConnectionBusy)}>{paypalConnectionBusy === "connect" ? "Authenticating sandbox app…" : "Authenticate sandbox app"}</button>
            </form>
          </details>
          {paypalConnection.connected && <button className="text-button" disabled={Boolean(paypalConnectionBusy)} onClick={() => void changePaypalConnection("disconnect")}>{paypalConnectionBusy === "disconnect" ? "Disconnecting…" : "Disconnect sandbox"}</button>}
          {paypalConnectionBusy && <p className="small-note" role="status">{paypalConnectionBusy === "status" ? "Checking local connection status…" : paypalConnectionBusy === "connect" ? "Checking the supplied app with PayPal’s sandbox…" : "Removing the sandbox connection…"}</p>}
          {appliedPaypalConnectionId && appliedPaypalConnectionId !== paypalConnection.connectionId && <p className="small-note">The loaded sandbox records came from an earlier connection. They remain historical observations until you explicitly replace them.</p>}
        </section>
        <div className="segmented-control" role="group" aria-label="Sandbox operation"><button className={paypalOperation === "capture" ? "active" : ""} aria-pressed={paypalOperation === "capture"} onClick={() => { resetPaypalPreview(); setPaypalOperation("capture"); }}>Known capture</button><button className={paypalOperation === "transactions" ? "active" : ""} aria-pressed={paypalOperation === "transactions"} onClick={() => { resetPaypalPreview(); setPaypalOperation("transactions"); }}>Reporting window</button></div>
        {paypalOperation === "capture" ? <label className="field-label">Sandbox capture ID<input value={captureId} onChange={(event) => { resetPaypalPreview(); setCaptureId(event.target.value); }} placeholder="A capture ID from your sandbox merchant" maxLength={64} /></label> : <><div className="date-fields"><label className="field-label">Start date (UTC)<input type="date" value={startDate} onChange={(event) => { resetPaypalPreview(); setStartDate(event.target.value); }} /></label><label className="field-label">End date (UTC)<input type="date" value={endDate} onChange={(event) => { resetPaypalPreview(); setEndDate(event.target.value); }} /></label></div><p className="small-note">At most 31 days and 1,000 records. Recent activity may take up to three hours to appear. A reporting window is not complete account history.</p></>}
        <div className="provider-actions"><button className="primary" disabled={!paypalStatusLoaded || !paypalConnection.connected || !paypalConnection.connectionId || paypalBusy || Boolean(paypalConnectionBusy)} onClick={() => void fetchPaypal()}>{paypalBusy ? paypalApplying ? "Checking preview connection…" : "Fetching sandbox evidence…" : "Fetch replacement preview"}</button>{paypalBusy && <button onClick={() => { resetPaypalPreview(); setPaypalError("Request stopped. Your current payment collection was kept."); }}>Cancel request</button>}</div>
        {paypalError && <p className="inline-error" role="alert">{paypalError}</p>}
        {paypalPreview && <section className="import-preview" aria-live="polite"><h3>{paypalPreview.payments.length} sandbox records returned</h3><p>{coverageLabel(paypalPreview.source)} · {paypalPreview.source.unsupportedCount} unsupported events</p><div className="preview-table"><table><thead><tr><th>Record</th><th>Status</th><th className="number">Gross</th></tr></thead><tbody>{paypalPreview.payments.slice(0, 5).map((payment) => <tr key={payment.id}><td>{payment.id}</td><td>{payment.status}</td><td className="number">{formatMoney(payment.grossMinor)}</td></tr>)}</tbody></table></div><div className="replacement-notice"><Icon name="info" /><p>Replace the entire payment collection with these returned records. Invoices remain. Prior review and AI clear. A known capture is one observation, not an account import.</p></div><button className="primary" disabled={paypalBusy || Boolean(paypalConnectionBusy)} onClick={() => void applyPaypal()}>{paypalApplying ? "Checking connection…" : "Apply sandbox replacement"}</button></section>}
      </div>}
      {modal === "sources" && <div className="dialog-body"><p className="dialog-intro">Source verification belongs to individual returned observations. Reviewing a match does not verify an imported file or establish complete account coverage.</p>{([{ title: "Invoice collection", source: dataset.invoiceSource, count: dataset.invoices.length }, { title: "Payment collection", source: dataset.paymentSource, count: dataset.payments.length }]).map(({ title, source, count }) => <section className="source-section" key={title}><div className="source-section-heading"><h3>{title}</h3><span>{count} records</span></div><dl className="source-facts"><div><dt>Source</dt><dd>{sourceLabel(source)}</dd></div><div><dt>Label</dt><dd>{source?.label || "Nothing loaded"}</dd></div><div><dt>Coverage</dt><dd>{coverageLabel(source)}</dd></div><div><dt>Provider verified</dt><dd>{source?.providerVerified ? "Only returned sandbox records" : "No"}</dd></div><div><dt>Observed range</dt><dd>{source?.rangeStart ? <>{source.rangeStart}{source.rangeEnd ? ` → ${source.rangeEnd}` : ""}</> : source?.kind === "paypal" && count === 0 ? "No records returned" : "Not supplied"}</dd></div><div><dt>Requested range</dt><dd>{source?.requestedRangeStart ? <>{source.requestedRangeStart}{source.requestedRangeEnd ? ` → ${source.requestedRangeEnd}` : ""}</> : "Not supplied"}</dd></div><div><dt>Query filters</dt><dd>{source?.filters?.length ? <div className="source-filter-list">{source.filters.map((filter, index) => <div key={`${filter.field}-${index}`}><span>{filter.field}</span> = {filter.value || "Not supplied"}</div>)}</div> : "Not supplied"}</dd></div><div><dt>Provider account identity</dt><dd>{source?.kind === "paypal" && source.providerVerified && source.accountIdentity ? <>{source.accountIdentity.kind === "account_number" ? "Account number" : "Merchant ID"} · {source.accountIdentity.value}</> : "Not supplied"}</dd></div>{source?.fetchedAt && <div><dt>Fetched</dt><dd>{source.fetchedAt}</dd></div>}<div><dt>Unsupported events</dt><dd>{source?.unsupportedCount ?? 0}</dd></div><div><dt>Exact duplicates excluded</dt><dd>{source?.duplicateCount ?? 0}</dd></div></dl>{source?.kind === "paypal" && <p className="small-note">Observed range describes returned records. Requested range and filters describe the API query; neither means the entire account history was retrieved.</p>}</section>)}<div className="source-actions"><button onClick={() => { changeImportKind("invoices"); setModal("import"); }}>Import replacement</button><button onClick={() => setModal("sample")}>Load sample ledger</button></div><p className="small-note">Save a workspace file before refreshing or closing this tab to keep records and manual decisions. Workspace files exclude AI content; a CSV export is a report, not a restorable session or durable audit log.</p></div>}
      {modal === "workspace" && <div className="dialog-body"><p className="dialog-intro">Save a local file to reopen your records and manual decisions in another session. Nothing is uploaded.</p>{workspaceError && <p className="inline-error" role="alert">{workspaceError}</p>}<section className="workspace-save-section"><div className="workspace-section-title"><Icon name="download" /><h3>Save this workspace</h3></div><p>{dataset.invoices.length} {dataset.invoices.length === 1 ? "invoice" : "invoices"} · {dataset.payments.length} payment {dataset.payments.length === 1 ? "record" : "records"} · {review.allocations.length} {review.allocations.length === 1 ? "confirmation" : "confirmations"} · {review.rejections.length} {review.rejections.length === 1 ? "rejection" : "rejections"}</p><button className="primary" onClick={saveWorkspace} disabled={!loaded}><Icon name="download" />Save workspace</button>{workspaceSaveStarted && <p className="workspace-save-status" role="status"><Icon name="check" />Workspace download started. Keep the JSON file to reopen this work.</p>}<p className="small-note">Includes records and applied manual decisions. Apply a decision to save its note. AI responses, excerpts, frozen AI evidence and draft notes are excluded.{!loaded && " Load records before saving."}</p></section><section className="workspace-open-section"><div className="workspace-section-title"><Icon name="source" /><h3>Open a saved workspace</h3></div><label className="field-label" htmlFor="workspace-file">Workspace JSON file <span>· up to 16 MiB</span></label><input type="file" id="workspace-file" accept=".json,application/json" onChange={readWorkspace} className="file-input" />{workspaceFilename && <p className="workspace-filename">{workspaceFilename}</p>}{workspaceReadBusy && <div className="workspace-read-status" role="status"><span>Validating workspace…</span><button onClick={() => { workspaceFileRequest.current += 1; setWorkspaceReadBusy(false); setToast("Workspace read cancelled. Your current records and decisions were kept."); }}>Cancel read</button></div>}{workspacePreview && <section className="workspace-restore-preview" aria-live="polite"><h4>Review before restoring</h4><dl><div><dt>Saved</dt><dd><time dateTime={workspacePreview.savedAt}>{new Date(workspacePreview.savedAt).toLocaleString()}</time></dd></div><div><dt>Invoices / payments</dt><dd>{workspacePreview.dataset.invoices.length} / {workspacePreview.dataset.payments.length}</dd></div><div><dt>Confirmations / rejections</dt><dd>{workspacePreview.review.allocations.length} / {workspacePreview.review.rejections.length}</dd></div><div><dt>Selected invoice</dt><dd>{workspacePreview.selectedInvoiceId ?? (workspacePreview.dataset.invoices.length ? "First available invoice" : "No invoices")}</dd></div></dl><div className="replacement-notice"><Icon name="info" /><p>This replaces current records and decisions. Restored sources are unverified imported files, even if the original data came from a sandbox API. Current and frozen AI results are cleared; no AI content is restored.</p></div><button className="primary" onClick={restoreWorkspace}>Restore records and decisions</button></section>}</section></div>}
      {modal === "receipt" && selected && <div className="dialog-body"><ReceiptPicker dataset={dataset} invoice={selected.invoice} reconciliation={reconciliation} onSelect={selectManualReceipt} /></div>}
      {modal === "sample" && <div className="dialog-body"><p className="dialog-intro">This replaces both invoice and payment collections with a synthetic sample. Prior confirmations, rejections and AI results will be cleared.</p><p className="small-note">The sample does not make a PayPal API request or simulate a successful AI investigation.</p><div className="dialog-footer"><button onClick={closeModal}>Keep current data</button><button className="primary" onClick={loadSample}>Replace with sample</button></div></div>}
    </dialog>
    {toast && <div className="toast" role="status"><Icon name={toast.startsWith("Evidence brief download failed") ? "info" : "check"} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><Icon name="close" /></button></div>}
  </div>;
}
