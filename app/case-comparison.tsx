import type { Dataset, InvoiceResult, Payment, Reconciliation } from "../lib/contracts";
import { formatMoney, isEligibleReceipt } from "../lib/reconciliation";

type CaseComparisonProps = {
  dataset: Dataset;
  reconciliation: Reconciliation;
  invoiceId: string;
  payment: Payment | null;
  onInvoice: (id: string) => void;
};

const customerKey = (value: string | null) => value?.trim().toLowerCase() ?? "";
const invoiceReference = (value: string | null) => value?.trim() ?? "";
const supplied = (value: string | null) => value?.trim() || "Not supplied";

function relationship(row: InvoiceResult, paymentId: string) {
  const candidate = row.candidatePayments.find((item) => item.payment.id === paymentId);
  const confirmed = row.confirmedPayments.some((item) => item.id === paymentId);
  return { candidate, confirmed };
}

function ineligibleReason(payment: Payment): string {
  if (payment.kind !== "receipt") return `This is a ${payment.kind} record, not an eligible incoming receipt.`;
  if (payment.status !== "completed") return `This receipt is ${payment.status.replaceAll("_", " ")}; it cannot establish invoice coverage.`;
  return "This record is not an eligible incoming receipt and cannot establish invoice coverage.";
}

export default function CaseComparison({ dataset, reconciliation, invoiceId, payment, onInvoice }: CaseComparisonProps) {
  const selected = reconciliation.rows.find((row) => row.invoice.id === invoiceId);

  if (!payment) {
    const hasReceipts = selected && (selected.candidatePayments.length > 0 || selected.confirmedPayments.length > 0);
    return <section className="comparison-panel" aria-label="Receipt comparison">
      <div className="comparison-heading"><h3>Receipt comparison</h3></div>
      <p className="comparison-empty">{hasReceipts ? "Select a receipt from the records below to compare its evidence with the candidate invoices." : "No available receipt supports this invoice within the loaded data. This does not prove it is unpaid."}</p>
      <h4 className="comparison-candidate-heading">Candidate invoices</h4>
      <p className="comparison-empty">A receipt must be selected before invoice evidence can be compared.</p>
    </section>;
  }

  const relatedRows = reconciliation.rows.filter((row) => {
    const { candidate, confirmed } = relationship(row, payment.id);
    return Boolean(candidate || confirmed);
  });
  const rows = selected ? [selected, ...relatedRows.filter((row) => row.invoice.id !== invoiceId)] : relatedRows;
  const owner = relatedRows.find((row) => relationship(row, payment.id).confirmed);
  const eligible = isEligibleReceipt(payment);
  const matchingRows = relatedRows.filter((row) => row.invoice.amountMinor === payment.grossMinor && customerKey(payment.customerKey) && customerKey(row.invoice.customerKey) === customerKey(payment.customerKey));
  const candidates = relatedRows.filter((row) => relationship(row, payment.id).candidate);
  const summary = owner
    ? `${payment.id} is confirmed for ${owner.invoice.id}. It cannot be allocated to another invoice.`
    : !eligible
      ? ineligibleReason(payment)
      : matchingRows.length > 1
        ? `Amount and customer key match ${matchingRows.length} candidate invoices. ${matchingRows.length === 2 ? "Neither association is" : "None of these associations are"} confirmed.`
        : candidates.length > 0
          ? `${candidates.length === 1 ? "One candidate invoice is" : `${candidates.length} candidate invoices are`} shown. ${candidates.length === 1 ? "The association remains" : "All associations remain"} unconfirmed.`
          : "No current candidate association exists for this receipt in the loaded data.";
  const paymentSource = dataset.paymentSource;
  const sourceLabel = paymentSource?.label ?? "Source not recorded";
  const sourceVerification = paymentSource?.providerVerified ? "Provider-verified source" : "Source is not provider-verified";

  return <section className="comparison-panel" aria-label="Receipt comparison">
    <div className="comparison-heading"><h3>Receipt comparison</h3><p>{summary}</p></div>

    <div className="comparison-receipt">
      <div className="comparison-receipt-heading"><h4>{payment.id}</h4><p className="comparison-source">{sourceLabel} · Source row {payment.sourceRow} · {sourceVerification}</p></div>
      <dl className="comparison-receipt-facts">
        <div className="comparison-gross"><dt>Receipt gross</dt><dd>{formatMoney(payment.grossMinor)}</dd></div>
        <div><dt>Fee cost</dt><dd>{payment.feeMinor === null ? "Unknown" : formatMoney(payment.feeMinor)}</dd></div>
        <div><dt>Receipt net</dt><dd>{payment.netMinor === null ? "Unknown" : formatMoney(payment.netMinor)}</dd></div>
        <div><dt>Currency</dt><dd>{payment.currency}</dd></div>
        <div><dt>Status / event</dt><dd>{payment.status.replaceAll("_", " ")} · {payment.kind} · {supplied(payment.eventCode)}</dd></div>
        <div><dt>Transaction date</dt><dd><time dateTime={payment.timestamp}>{payment.timestamp}</time></dd></div>
        <div><dt>Structured invoice ID</dt><dd>{supplied(payment.invoiceId)}</dd></div>
        <div><dt>Receipt customer key</dt><dd>{supplied(payment.customerKey)}</dd></div>
        <div><dt>Provider transaction ID</dt><dd>{payment.providerId}</dd></div>
      </dl>
      <p className="comparison-financial-note">Gross is compared with the invoice amount. Fee cost and net stay separate.{payment.feeMinor === null ? " An unknown fee is not a zero fee." : ""}</p>
    </div>

    <div className="comparison-memo"><h4>Original remittance · {payment.id}</h4>{payment.memo.trim() ? <blockquote>{payment.memo}</blockquote> : <p>Not supplied</p>}</div>

    <div className="comparison-table-wrap" role="region" aria-label={`Candidate invoices for ${payment.id}`} tabIndex={0}>
      <table className="comparison-table">
        <caption>Candidate invoices</caption>
        <thead><tr><th scope="col">Invoice</th><th scope="col">Invoice amount</th><th scope="col">Amount match</th><th scope="col">Customer key</th><th scope="col">Invoice reference</th><th scope="col">Review state</th></tr></thead>
        <tbody>{rows.map((row) => {
          const { invoice } = row;
          const { candidate, confirmed } = relationship(row, payment.id);
          const current = invoice.id === invoiceId;
          const actualRelationship = Boolean(candidate || confirmed);
          const receiptCustomer = customerKey(payment.customerKey);
          const invoiceCustomer = customerKey(invoice.customerKey);
          const reference = invoiceReference(payment.invoiceId);
          const directReference = reference !== "" && reference === invoiceReference(invoice.id);
          const reviewState = confirmed ? "Confirmed for this invoice" : owner ? `Confirmed for ${owner.invoice.id}; unavailable here` : !actualRelationship ? "No current candidate relationship" : !eligible || candidate?.eligible === false ? "Ineligible receipt; cannot allocate" : "Eligible receipt · association unconfirmed";

          return <tr key={invoice.id} className={`${current ? "comparison-current" : ""}${confirmed ? " comparison-confirmed" : ""}`} aria-current={current ? "true" : undefined}>
            <th scope="row"><div className="comparison-invoice">{!current && actualRelationship ? <button type="button" onClick={() => onInvoice(invoice.id)} aria-label={`Inspect ${invoice.id} for ${payment.id}`}>{invoice.id}</button> : <strong>{invoice.id}</strong>}<span>{invoice.customer}</span><small>Due <time dateTime={invoice.dueDate}>{invoice.dueDate}</time> · Source row {invoice.sourceRow}</small>{current && <small>Current invoice</small>}</div></th>
            <td className="comparison-amount">{formatMoney(invoice.amountMinor)}<small>{invoice.currency}</small></td>
            <td>{invoice.amountMinor === payment.grossMinor ? "Matches gross" : "Differs from gross"}</td>
            <td>{!receiptCustomer ? "Receipt key not supplied" : !invoiceCustomer ? "Invoice key not supplied" : receiptCustomer === invoiceCustomer ? "Same key" : "Different key"}<small>{supplied(invoice.customerKey)}</small></td>
            <td>{directReference ? "Direct reference" : reference ? `References ${reference}` : "Not supplied"}</td>
            <td><span className="comparison-review-state">{reviewState}</span>{candidate && <p className="comparison-reason">{candidate.reason}</p>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="comparison-table-note">{rows.length} {rows.length === 1 ? "invoice" : "invoices"} shown · Invoice source: {dataset.invoiceSource?.label ?? "Source not recorded"}. Amount or customer agreement alone does not confirm an association.</p>
  </section>;
}
