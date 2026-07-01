import { useState, type RefObject } from "react";
import type { Dataset } from "../lib/contracts";
import type { ExceptionDesk, TriageFinding } from "../lib/case-intelligence";
import { formatMoney } from "../lib/reconciliation";

type FindingKind = TriageFinding["kind"] | "all";
type Props = {
  dataset: Dataset;
  desk: ExceptionDesk;
  findings: TriageFinding[];
  totalFindings: number;
  selectedId: string | null;
  selectedPaymentId: string | null;
  query: string;
  kind: FindingKind;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onKind: (kind: FindingKind) => void;
  onInvoice: (id: string, paymentId?: string) => void;
  onReceipt: (id: string) => void;
  onLedger: () => void;
  invoiceButtonRef: (id: string, element: HTMLButtonElement | null) => void;
};

const KIND_LABELS: Record<TriageFinding["kind"], string> = {
  "competing-receipt": "Choose an invoice",
  "receipt-combination": "Check payment combination",
  refund: "Refund to check",
  partial: "Part payment",
  pending: "Pending",
  overpayment: "Amount to check",
  "missing-receipt": "Missing receipt",
  unsupported: "Unsupported event",
};

function FindingDetails({ finding }: { finding: TriageFinding }) {
  const [open, setOpen] = useState(false);
  return <details className="finding-support" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Details</summary><p>{finding.description}</p><div className="finding-next-step"><span>Next step</span><p>{finding.nextStep}</p></div>{open && <div className="finding-citations" aria-label="Supporting evidence IDs">{finding.evidenceIds.map((id) => <span key={id}>{id}</span>)}</div>}</details>;
}

export default function InvestigationDesk({ dataset, desk, findings, totalFindings, selectedId, selectedPaymentId, query, kind, searchRef, onQuery, onKind, onInvoice, onReceipt, onLedger, invoiceButtonRef }: Props) {
  const hasFilters = Boolean(query || kind !== "all");
  const invoices = new Map(dataset.invoices.map((invoice) => [invoice.id, invoice]));
  const payments = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  return <div className="investigation-desk">
    <div className="desk-heading"><h2>Work queue</h2><span className="desk-finding-count">{totalFindings} {totalFindings === 1 ? "case" : "cases"}</span></div>
    <div className="desk-toolbar">
      <label className="search desk-search"><span className="search-label">Search queue</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref={searchRef} type="search" placeholder="Invoice or receipt ID" value={query} onChange={(event) => onQuery(event.target.value)} /></label>
      <label className="queue-kind-filter"><span>Exception type</span><select value={kind} onChange={(event) => onKind(event.target.value as FindingKind)}><option value="all">All types ({desk.findings.length})</option>{(Object.keys(KIND_LABELS) as TriageFinding["kind"][]).map((value) => {
        const count = desk.findings.filter((finding) => finding.kind === value).length;
        return <option value={value} key={value} disabled={count === 0 && kind !== value}>{KIND_LABELS[value]} ({count})</option>;
      })}</select></label>
    </div>
    <details className="collection-totals"><summary>Collection totals</summary><dl><div><dt>Original gross awaiting allocation</dt><dd>{formatMoney(desk.unallocatedGrossMinor)}</dd></div><div><dt>Eligible unallocated receipts</dt><dd>{desk.unallocatedReceiptCount} · counted once</dd></div><div><dt>Pending · excluded</dt><dd>{formatMoney(desk.pendingGrossMinor)}</dd></div><div><dt>Refunds & reversals</dt><dd>{formatMoney(desk.adjustmentGrossMinor)}</dd></div></dl><p>These amounts describe the loaded payment collection. Original gross can include receipts linked to exceptions; it is not available cash or a settled balance.</p><p>{dataset.paymentSource?.providerVerified ? "Only returned sandbox observations are provider-verified." : dataset.paymentSource?.kind === "sample" ? "Synthetic sample records; not provider-verified." : "Imported file records; not provider-verified."}</p></details>
    <div className="finding-list" aria-label="Receipt investigation queue">{findings.map((finding, index) => {
      const selected = selectedId !== null && finding.invoiceIds.includes(selectedId) && (!finding.paymentIds.length || finding.paymentIds.includes(selectedPaymentId ?? ""));
      const preferredPaymentId = finding.paymentIds.find((id) => dataset.payments.some((payment) => payment.id === id && payment.kind === "receipt")) ?? finding.paymentIds[0];
      const customers = [...new Set(finding.invoiceIds.flatMap((id) => invoices.get(id)?.customer ?? []))];
      const title = customers.length === 1 ? customers[0] : customers.length > 1 ? `${customers.length} possible clients` : finding.kind === "refund" ? "Unassigned adjustment" : "Unassigned receipt";
      const invoice = finding.invoiceIds.length === 1 ? invoices.get(finding.invoiceIds[0]) : null;
      const firstIds = selectedId && finding.invoiceIds.includes(selectedId) ? [selectedId, ...finding.invoiceIds.filter((id) => id !== selectedId)] : finding.invoiceIds;
      return <article className={`finding finding-${finding.kind} ${selected ? "finding-selected" : ""}`} key={finding.id} aria-labelledby={`finding-title-${index}`}>
        <div className="finding-header"><div className="finding-identity"><h3 id={`finding-title-${index}`} className="finding-customer">{title}</h3><span className="finding-issue finding-classification">{KIND_LABELS[finding.kind]}</span></div></div>
        {invoice?.description && <p className="finding-purpose">{invoice.description}</p>}
        {finding.paymentIds.length > 0 ? <div className="finding-payment-strip">{finding.paymentIds.slice(0, 2).map((id) => {
          const payment = payments.get(id);
          return <div className="finding-receipt-record" key={id}><div className="finding-receipt-meta"><span className="finding-record-label">Source record</span><button className="finding-receipt-link" onClick={() => onReceipt(id)} aria-label={`Inspect payment event ${id}`}>{id}</button></div>{payment && <span className="finding-payment-amount">{formatMoney(payment.grossMinor)}<small>{payment.status.replaceAll("_", " ")}</small></span>}</div>;
        })}{finding.paymentIds.length > 2 && <p className="finding-record-count">{finding.paymentIds.length} source records · all IDs in details</p>}</div> : <p className="finding-no-invoice">No eligible receipt in the loaded data.</p>}
        {finding.invoiceIds.length > 0 ? <div className="finding-related-invoices"><p className="finding-invoices-heading">Related invoices</p><div className="finding-invoice-actions" aria-label="Related invoices">{firstIds.slice(0, 2).map((id) => {
          const current = id === selectedId && selected;
          return <button key={id} className={current ? "current" : ""} ref={(element) => invoiceButtonRef(id, element)} onClick={() => onInvoice(id, preferredPaymentId)} aria-label={`Review ${id}`} aria-current={current ? "true" : undefined}><span>{id}</span>{current ? <small>Selected</small> : <span aria-hidden="true">→</span>}</button>;
        })}{finding.invoiceIds.length > 2 && <button className="finding-more-invoices" onClick={() => onInvoice(firstIds[0], preferredPaymentId)}>Compare all {finding.invoiceIds.length} invoices →</button>}</div></div> : <p className="finding-no-invoice">No linked invoice. Inspect the source event.</p>}
        <FindingDetails finding={finding} />
      </article>;
    })}</div>
    {findings.length === 0 && <div className="desk-empty"><h3>{hasFilters ? "No matching cases" : "No invoice exceptions to review"}</h3><p>{hasFilters ? "Change the exception type or search." : "Check the invoice ledger and unallocated receipts against your source records."}</p>{hasFilters ? <button onClick={() => { onQuery(""); onKind("all"); }}>Clear filters</button> : <button onClick={onLedger}>Open invoice ledger</button>}</div>}
  </div>;
}
