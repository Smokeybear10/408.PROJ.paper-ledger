import { useState } from "react";
import type { Dataset, Invoice, Payment, Reconciliation } from "../lib/contracts";
import { formatMoney } from "../lib/reconciliation";

type Props = {
  dataset: Dataset;
  invoice: Invoice;
  reconciliation: Reconciliation;
  onSelect: (paymentId: string) => void;
};

const PAGE_SIZE = 12;

function relationship(payment: Payment, invoice: Invoice): string {
  if (payment.invoiceId?.trim()) return payment.invoiceId.trim() === invoice.id ? "Invoice reference agrees" : `References ${payment.invoiceId}`;
  const payer = payment.customerKey?.trim().toLowerCase();
  const customer = invoice.customerKey.trim().toLowerCase();
  if (payer && customer && payer === customer) return "Same customer · no invoice reference";
  return "No matching customer or invoice reference";
}

export default function ReceiptPicker({ dataset, invoice, reconciliation, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const term = query.trim().toLowerCase();
  const payments = reconciliation.unallocatedPayments.filter((payment) => `${payment.id} ${payment.providerId} ${payment.customerKey ?? ""} ${payment.invoiceId ?? ""} ${payment.memo} ${formatMoney(payment.grossMinor)} ${(payment.grossMinor / 100).toFixed(2)}`.toLowerCase().includes(term));
  const pageCount = Math.max(1, Math.ceil(payments.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = payments.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return <div className="receipt-picker">
    <div className="receipt-picker-invoice"><span>Reviewing {invoice.id}</span><strong>{invoice.customer}</strong><p>{invoice.description || "Invoice"} · {formatMoney(invoice.amountMinor)}</p></div>
    <label className="field-label" htmlFor="find-receipt">Search all unallocated receipts</label>
    <input id="find-receipt" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Receipt ID, payer, note or amount" />
    <p className="small-note">A selection opens the receipt for review; it does not confirm a match. An explicit invoice reference cannot be overridden.</p>
    <div className="receipt-picker-list" aria-label="Unallocated receipts">
      {visible.map((payment) => {
        const conflict = Boolean(payment.invoiceId?.trim() && payment.invoiceId.trim() !== invoice.id);
        return <article className={`receipt-picker-row ${conflict ? "receipt-picker-conflict" : ""}`} key={payment.id}>
          <div><strong>{payment.id}</strong><span>{payment.customerKey || "Customer not supplied"} · {payment.timestamp.slice(0, 10)}</span><p>{payment.memo || "No payment note supplied"}</p><small>{relationship(payment, invoice)}</small></div>
          <div className="receipt-picker-choice"><strong>{formatMoney(payment.grossMinor)}</strong><button disabled={conflict} onClick={() => onSelect(payment.id)} aria-label={`Review ${payment.id} for ${invoice.id}`}>{conflict ? "Different invoice" : "Use in review"}</button></div>
        </article>;
      })}
      {!visible.length && <div className="receipt-picker-empty"><h3>{term ? "No receipts match this search" : "No eligible unallocated receipts"}</h3><p>{term ? "Try a receipt ID, amount or phrase from the payment note." : "Pending, failed, refunded and unsupported records cannot establish settled coverage."}</p>{term && <button onClick={() => { setQuery(""); setPage(0); }}>Clear search</button>}</div>}
    </div>
    <div className="receipt-picker-pagination"><span>{payments.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, payments.length)} of ${payments.length}` : "0 receipts"}{term && ` · ${reconciliation.unallocatedPayments.length} total`}</span>{pageCount > 1 && <div className="pagination"><button aria-label="Previous unallocated receipts" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>←</button><span>{currentPage + 1} / {pageCount}</span><button aria-label="Next unallocated receipts" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>→</button></div>}</div>
    <p className="small-note">{dataset.paymentSource?.kind === "sample" ? "Synthetic sample receipts" : dataset.paymentSource?.kind === "paypal" && dataset.paymentSource.providerVerified ? "Returned sandbox observations" : "Imported receipts · not provider-verified"}. Fees and net amounts remain available in the selected receipt’s source details.</p>
  </div>;
}
