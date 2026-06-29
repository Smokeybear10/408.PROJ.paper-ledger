import type { RefObject } from "react";
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
  query: string;
  kind: FindingKind;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onKind: (kind: FindingKind) => void;
  onInvoice: (id: string) => void;
  onReceipt: (id: string) => void;
  onLedger: () => void;
  invoiceButtonRef: (id: string, element: HTMLButtonElement | null) => void;
};

const KIND_LABELS: Record<TriageFinding["kind"], string> = {
  "competing-receipt": "Competing receipt",
  refund: "Refund",
  partial: "Partial coverage",
  pending: "Pending",
  overpayment: "Overpayment",
  "missing-receipt": "Missing receipt",
  unsupported: "Unsupported event",
};

export default function InvestigationDesk({ dataset, desk, findings, totalFindings, selectedId, query, kind, searchRef, onQuery, onKind, onInvoice, onReceipt, onLedger, invoiceButtonRef }: Props) {
  const hasFilters = Boolean(query || kind !== "all");
  return <div className="investigation-desk">
    <div className="desk-heading"><h2>Work queue</h2><span className="desk-finding-count">{totalFindings} {totalFindings === 1 ? "case" : "cases"}</span></div>
    <label className="search desk-search"><span className="search-label">Search queue</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref={searchRef} type="search" placeholder="Invoice or receipt ID" value={query} onChange={(event) => onQuery(event.target.value)} /></label>
    <label className="queue-kind-filter"><span>Exception type</span><select value={kind} onChange={(event) => onKind(event.target.value as FindingKind)}><option value="all">All types ({desk.findings.length})</option>{(Object.keys(KIND_LABELS) as TriageFinding["kind"][]).map((value) => {
      const count = desk.findings.filter((finding) => finding.kind === value).length;
      return <option value={value} key={value} disabled={count === 0 && kind !== value}>{KIND_LABELS[value]} ({count})</option>;
    })}</select></label>
    <details className="collection-totals"><summary>Collection totals</summary><dl><div><dt>Original gross awaiting allocation</dt><dd>{formatMoney(desk.unallocatedGrossMinor)}</dd></div><div><dt>Eligible unallocated receipts</dt><dd>{desk.unallocatedReceiptCount} · counted once</dd></div><div><dt>Pending · excluded</dt><dd>{formatMoney(desk.pendingGrossMinor)}</dd></div><div><dt>Refunds & reversals</dt><dd>{formatMoney(desk.adjustmentGrossMinor)}</dd></div></dl><p>These amounts describe the loaded payment collection. Original gross can include receipts linked to exceptions; it is not available cash or a settled balance.</p><p>{dataset.paymentSource?.providerVerified ? "Only returned sandbox observations are provider-verified." : dataset.paymentSource?.kind === "sample" ? "Synthetic sample records; not provider-verified." : "Imported file records; not provider-verified."}</p></details>
    <div className="finding-list" aria-label="Receipt investigation queue">{findings.map((finding, index) => {
      const selected = selectedId !== null && finding.invoiceIds.includes(selectedId);
      return <article className={`finding finding-${finding.kind} ${selected ? "finding-selected" : ""}`} key={finding.id} aria-labelledby={`finding-title-${index}`}>
        <div className="finding-header"><h3 id={`finding-title-${index}`} className="finding-kind">{KIND_LABELS[finding.kind]}</h3><span className={`finding-priority priority-${finding.priority}`}>{finding.priority}</span></div>
        {finding.paymentIds.length > 0 ? <div className="finding-payment-strip">{finding.paymentIds.map((id) => {
          const payment = dataset.payments.find((row) => row.id === id);
          return <div key={id}><button className="finding-receipt-link" onClick={() => onReceipt(id)} aria-label={`Inspect payment event ${id}`}>{id}</button>{payment && <span className="finding-payment-amount">{formatMoney(payment.grossMinor)}<small>{payment.status.replaceAll("_", " ")}</small></span>}</div>;
        })}</div> : <p className="finding-no-invoice">No eligible receipt in the loaded data.</p>}
        {finding.invoiceIds.length > 0 ? <div className="finding-invoice-actions" aria-label="Related invoices">{finding.invoiceIds.map((id) => {
          const current = id === selectedId;
          return <button key={id} className={current ? "current" : ""} ref={(element) => invoiceButtonRef(id, element)} onClick={() => onInvoice(id)} aria-label={`Review ${id}`} aria-current={current ? "true" : undefined}><span>{id}</span>{current ? <small>Selected</small> : <span aria-hidden="true">→</span>}</button>;
        })}</div> : <p className="finding-no-invoice">No linked invoice. Inspect the source event.</p>}
        <details className="finding-support"><summary>Details</summary><p>{finding.description}</p><div className="finding-next-step"><span>Next step</span><p>{finding.nextStep}</p></div><div className="finding-citations" aria-label="Supporting evidence IDs">{finding.evidenceIds.map((id) => <span key={id}>{id}</span>)}</div></details>
      </article>;
    })}</div>
    {findings.length === 0 && <div className="desk-empty"><h3>{hasFilters ? "No matching cases" : "No receipt exceptions in the loaded records"}</h3><p>{hasFilters ? "Change the exception type or search." : "Review the invoice ledger for current allocations and source coverage."}</p>{hasFilters ? <button onClick={() => { onQuery(""); onKind("all"); }}>Clear filters</button> : <button onClick={onLedger}>Open invoice ledger</button>}</div>}
  </div>;
}
