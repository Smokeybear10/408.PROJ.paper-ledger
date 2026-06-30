import { useRef, useState } from "react";
import type { CandidatePayment, Dataset, InvoiceResult, Payment, Reconciliation } from "../lib/contracts";
import { formatMoney, isEligibleReceipt } from "../lib/reconciliation";

type CaseComparisonProps = {
  dataset: Dataset;
  reconciliation: Reconciliation;
  invoiceId: string;
  payment: Payment | null;
  onInvoice: (id: string) => void;
  comparisonId?: string;
};
type ComparisonEntry = { row: InvoiceResult; candidate: CandidatePayment | undefined; confirmed: boolean };
type CandidateInvoicesProps = {
  entries: ComparisonEntry[];
  relatedCount: number;
  invoiceId: string;
  payment: Payment;
  ownerId: string | null;
  sourceLabel: string;
  onInvoice: (id: string) => void;
};

const PAGE_SIZE = 20;
const customerKey = (value: string | null) => value?.trim().toLowerCase() ?? "";
const invoiceReference = (value: string | null) => value?.trim() ?? "";
const supplied = (value: string | null) => value?.trim() || "Not supplied";

function ineligibleReason(payment: Payment): string {
  if (payment.kind === "other") return "This source event is not an eligible incoming receipt.";
  if (payment.kind !== "receipt") return `This is a ${payment.kind} record, not an eligible incoming receipt.`;
  if (payment.status !== "completed") return `This receipt is ${payment.status.replaceAll("_", " ")}; it cannot establish invoice coverage.`;
  return "This record is not an eligible incoming receipt and cannot establish invoice coverage.";
}

function CandidateInvoices({ entries, relatedCount, invoiceId, payment, ownerId, sourceLabel, onInvoice }: CandidateInvoicesProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);
  const term = query.trim().toLowerCase();
  const filtered = entries.filter(({ row: { invoice } }) => `${invoice.id} ${invoice.customer} ${invoice.customerKey} ${invoice.description ?? ""}`.toLowerCase().includes(term));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const currentVisible = visible.some(({ row }) => row.invoice.id === invoiceId);
  const eligible = isEligibleReceipt(payment);
  const shownCount = filtered.length > PAGE_SIZE ? `${pageStart + 1}–${pageStart + visible.length} of ${filtered.length}` : String(filtered.length);

  function changePage(next: number) {
    setPage(next);
    tableRef.current?.scrollTo({ top: 0 });
  }

  function showCurrent() {
    setQuery("");
    changePage(0);
  }

  return <div className="comparison-candidates">
    <div className="comparison-candidate-heading"><div><h4>{relatedCount === 1 ? "Related invoice" : "Possible invoices"}</h4><p>{relatedCount} {relatedCount === 1 ? "relationship" : "relationships"} in the loaded records</p></div>{!currentVisible && entries.some(({ row }) => row.invoice.id === invoiceId) && <button type="button" className="text-button" onClick={showCurrent}>Show current invoice</button>}</div>
    {(entries.length > 5 || query) && <label className="comparison-search">Search candidate invoices<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); changePage(0); }} placeholder="Invoice, customer or context" /></label>}
    <p className="comparison-scroll-hint">Scroll across for receipt evidence.</p>
    <div className="comparison-table-wrap" ref={tableRef} role="region" aria-label={`Candidate invoices for ${payment.id}`} tabIndex={0}>
      <table className="comparison-table">
        <caption className="sr-only">Candidate invoices</caption>
        <thead><tr><th scope="col">Invoice</th><th scope="col">Amount</th><th scope="col">Receipt evidence</th></tr></thead>
        <tbody>{visible.map(({ row, candidate, confirmed }) => {
          const { invoice } = row;
          const current = invoice.id === invoiceId;
          const actualRelationship = Boolean(candidate || confirmed);
          const receiptCustomer = customerKey(payment.customerKey);
          const invoiceCustomer = customerKey(invoice.customerKey);
          const reference = invoiceReference(payment.invoiceId);
          const directReference = reference !== "" && reference === invoiceReference(invoice.id);
          const reviewState = confirmed ? "Confirmed for this invoice" : ownerId ? `Confirmed for ${ownerId}; unavailable here` : !actualRelationship ? "No current candidate relationship" : !eligible || candidate?.eligible === false ? "Ineligible receipt; cannot allocate" : "Unconfirmed association";

          return <tr key={invoice.id} className={`${current ? "comparison-current" : ""}${confirmed ? " comparison-confirmed" : ""}`} aria-current={current ? "true" : undefined}>
            <th scope="row"><div className="comparison-invoice">{!current && actualRelationship ? <button type="button" className="comparison-invoice-action" onClick={() => onInvoice(invoice.id)}><span className="comparison-invoice-context">{invoice.description?.trim() || invoice.customer}</span><span className="comparison-invoice-title"><span className="comparison-invoice-id">{invoice.id}</span><span className="comparison-inspect-label">Inspect →</span></span>{invoice.description?.trim() && <span className="comparison-invoice-customer">{invoice.customer}</span>}</button> : <><p className="comparison-invoice-context">{invoice.description?.trim() || invoice.customer}</p><div className="comparison-invoice-title"><strong>{invoice.id}</strong>{current && <span>Reviewing</span>}</div>{invoice.description?.trim() && <span>{invoice.customer}</span>}</>}<details className="comparison-invoice-source"><summary>Invoice details</summary><dl><div><dt>Due date</dt><dd><time dateTime={invoice.dueDate}>{invoice.dueDate}</time></dd></div><div><dt>Customer key</dt><dd>{supplied(invoice.customerKey)}</dd></div><div><dt>Source row</dt><dd>{invoice.sourceRow}</dd></div></dl></details></div></th>
            <td className="comparison-amount"><strong>{formatMoney(invoice.amountMinor)}</strong><span>{invoice.amountMinor === payment.grossMinor ? "Matches gross" : "Differs from gross"}</span></td>
            <td><ul className="comparison-evidence-lines"><li>{!receiptCustomer ? "Receipt customer key not supplied" : !invoiceCustomer ? "Invoice customer key not supplied" : receiptCustomer === invoiceCustomer ? "Same customer key" : "Different customer key"}</li><li>{directReference ? "Direct invoice reference" : reference ? `Receipt references ${reference}` : "No structured invoice reference"}</li></ul><p className="comparison-review-state">{reviewState}</p>{candidate && <details className="comparison-match-rule"><summary>Matching rule</summary><p>{candidate.reason}</p></details>}</td>
          </tr>;
        })}</tbody>
      </table>
      {!visible.length && <div className="comparison-no-results"><p>No candidate invoices match <strong>{query}</strong>.</p><button type="button" onClick={showCurrent}>Clear search</button></div>}
    </div>
    <div className="comparison-pagination"><p aria-live="polite">{shownCount} {term ? `${filtered.length === 1 ? "match" : "matches"} · ${entries.length} total ${entries.length === 1 ? "invoice" : "invoices"}` : filtered.length === 1 ? "invoice" : "invoices"}</p>{pageCount > 1 && <div><button type="button" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)} aria-label="Previous candidate invoice page">Previous</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => changePage(currentPage + 1)} aria-label="Next candidate invoice page">Next</button></div>}</div>
    {entries.length !== relatedCount && <p className="comparison-table-note">The current invoice is included for inspection; it has no available relationship to this receipt.</p>}
    <details className="comparison-invoice-provenance"><summary>Invoice collection source</summary><p>{sourceLabel}</p></details>
  </div>;
}

export default function CaseComparison({ dataset, reconciliation, invoiceId, payment, onInvoice, comparisonId = "candidate-invoices" }: CaseComparisonProps) {
  const selected = reconciliation.rows.find((row) => row.invoice.id === invoiceId);

  if (!payment) {
    const hasReceipts = selected && (selected.candidatePayments.length > 0 || selected.confirmedPayments.length > 0);
    return <section className="comparison-panel" id={comparisonId} tabIndex={-1} aria-label="Receipt comparison"><div className="comparison-heading"><h3>Payment evidence</h3></div><p className="comparison-empty">{hasReceipts ? "Choose a receipt to compare it with this invoice." : "No available receipt supports this invoice in the loaded records. Check the source coverage before treating it as unpaid."}</p></section>;
  }

  const entries = reconciliation.rows.map((row) => ({ row, candidate: row.candidatePayments.find((item) => item.payment.id === payment.id), confirmed: row.confirmedPayments.some((item) => item.id === payment.id) }));
  const related = entries.filter(({ candidate, confirmed }) => candidate || confirmed);
  const current = entries.find(({ row }) => row.invoice.id === invoiceId);
  const comparisonEntries = current ? [current, ...related.filter(({ row }) => row.invoice.id !== invoiceId)] : related;
  const owner = related.find(({ confirmed }) => confirmed)?.row.invoice ?? null;
  const eligible = isEligibleReceipt(payment);
  const matchingCount = related.filter(({ row }) => row.invoice.amountMinor === payment.grossMinor && customerKey(payment.customerKey) && customerKey(row.invoice.customerKey) === customerKey(payment.customerKey)).length;
  const summary = owner
    ? `${payment.id} is confirmed for ${owner.id}. It cannot be allocated to another invoice.`
    : !eligible
      ? ineligibleReason(payment)
      : matchingCount > 1
        ? `Amount and customer key match ${matchingCount} invoices. ${matchingCount === 2 ? "Neither association is" : "None of these associations are"} confirmed.`
        : related.length > 0
          ? `${related.length === 1 ? "One invoice has" : `${related.length} invoices have`} a candidate relationship. Manual review is required.`
          : "No current candidate association exists for this receipt in the loaded data.";
  const source = dataset.paymentSource;

  return <section className="comparison-panel" id={comparisonId} tabIndex={-1} aria-label="Receipt comparison">
    <div className="comparison-heading"><h3>Payment evidence</h3><p>{summary}</p>{owner && owner.id !== invoiceId && <button type="button" className="text-button" onClick={() => onInvoice(owner.id)}>Inspect confirmed invoice {owner.id}</button>}</div>
    <div className="comparison-receipt"><div className="comparison-receipt-heading"><h4>{payment.id}</h4><span>{payment.kind} · {payment.status.replaceAll("_", " ")}</span></div><dl className="comparison-money-bridge"><div className="comparison-gross"><dt>Gross · {payment.currency}</dt><dd>{formatMoney(payment.grossMinor)}</dd></div><div><dt>Fee cost</dt><dd>{payment.feeMinor === null ? "Unknown" : formatMoney(payment.feeMinor)}</dd></div><div><dt>Net</dt><dd>{payment.netMinor === null ? "Unknown" : formatMoney(payment.netMinor)}</dd></div></dl></div>
    <div className="comparison-evidence-layout">
      <div className="comparison-remittance"><div className="comparison-memo"><h4>Payment note</h4>{payment.memo.trim() ? <blockquote>{payment.memo}</blockquote> : <p>No remittance text supplied.</p>}</div><p className="comparison-reference"><span>Invoice reference <strong>{payment.invoiceId?.trim() || "not supplied"}</strong></span><span>Customer key <strong>{supplied(payment.customerKey)}</strong></span></p><details className="comparison-source-details"><summary>Receipt source details</summary><dl><div><dt>Source</dt><dd>{source?.label ?? "Source not recorded"}</dd></div><div><dt>Provider verified</dt><dd>{source?.kind === "paypal" && source.providerVerified ? "Only returned sandbox observations" : "No"}</dd></div><div><dt>Source row</dt><dd>{payment.sourceRow}</dd></div><div><dt>Provider transaction ID</dt><dd>{payment.providerId}</dd></div><div><dt>Event / currency</dt><dd>{supplied(payment.eventCode)} / {payment.currency}</dd></div><div><dt>Transaction date</dt><dd><time dateTime={payment.timestamp}>{payment.timestamp}</time></dd></div></dl><p>Gross is compared with the invoice amount. Fee cost and net stay separate.{payment.feeMinor === null ? " An unknown fee is not a zero fee." : ""}</p></details></div>
      {comparisonEntries.length ? <CandidateInvoices key={`${dataset.revision}:${invoiceId}:${payment.id}`} entries={comparisonEntries} relatedCount={related.length} invoiceId={invoiceId} payment={payment} ownerId={owner?.id ?? null} sourceLabel={dataset.invoiceSource?.label ?? "Source not recorded"} onInvoice={onInvoice} /> : <p className="comparison-empty">No invoice relationship exists in the loaded records. Check the original source and collection coverage before drawing a payment conclusion.</p>}
    </div>
  </section>;
}
