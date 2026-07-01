import { useMemo } from "react";
import type { Dataset, ReviewState } from "../lib/contracts";
import { findReceiptCombinations } from "../lib/receipt-combinations";
import { formatMoney } from "../lib/reconciliation";

type Props = {
  dataset: Dataset;
  review: ReviewState;
  invoiceId: string;
  checkedIds: string[];
  onSelect: (paymentIds: string[]) => void;
};

export default function ReceiptCombinations({ dataset, review, invoiceId, checkedIds, onSelect }: Props) {
  const result = useMemo(() => findReceiptCombinations(dataset, review, invoiceId), [dataset, review, invoiceId]);
  const payments = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  if (result.status === "missing" || result.status === "settled" || (result.candidateCount < 2 && !result.excludedAdjustmentCount)) return null;

  return <details className="receipt-combinations" open>
    <summary>Find a payment combination <span>{formatMoney(result.targetMinor)} remaining</span></summary>
    <div className="combination-content">
      {result.status === "limit" ? <p role="status">{result.candidateCount} related receipts are available. Exact search supports up to 24 at once; no receipts were silently omitted. Review this case manually.</p> : <>
        <p className="combination-result" role="status">{result.totalCombinations === 0 ? "No exact combination in this scope." : `${result.totalCombinations.toLocaleString("en-US")} exact ${result.totalCombinations === 1 ? "combination" : "combinations"} in this scope.`}</p>
        {result.totalCombinations > 0 && <p>Equal totals do not prove a match. Check the receipt notes and invoice purpose before confirming.</p>}
        <ol className="combination-list">
          {result.combinations.map((combination) => {
            const selected = checkedIds.length === combination.paymentIds.length && combination.paymentIds.every((id) => checkedIds.includes(id));
            return <li key={JSON.stringify(combination.paymentIds)}>
              <div className="combination-receipts">{combination.paymentIds.map((id) => <div key={id}><span>{id}</span><strong>{formatMoney(payments.get(id)!.grossMinor)}</strong></div>)}</div>
              <div className="combination-total"><span>{combination.paymentIds.length} {combination.paymentIds.length === 1 ? "receipt" : "receipts"}</span><strong>{formatMoney(combination.grossMinor)}</strong></div>
              {combination.competingInvoiceIds.length > 0 && <p className="combination-conflict">Also a candidate for {combination.competingInvoiceIds.slice(0, 3).join(", ")}{combination.competingInvoiceIds.length > 3 ? ` and ${combination.competingInvoiceIds.length - 3} more invoices` : ""}.</p>}
              <button aria-pressed={selected} disabled={selected} onClick={() => onSelect(combination.paymentIds)}>{selected ? "Selected for review" : "Review this combination"}</button>
            </li>;
          })}
        </ol>
        {result.totalCombinations > result.combinations.length && <p>Showing {result.combinations.length} of {result.totalCombinations.toLocaleString("en-US")} exact combinations. None is ranked as more likely.</p>}
      </>}
      {result.excludedAdjustmentCount > 0 && <p className="combination-conflict">{result.excludedAdjustmentCount} {result.excludedAdjustmentCount === 1 ? "receipt has" : "receipts have"} linked refund or reversal evidence and {result.excludedAdjustmentCount === 1 ? "is" : "are"} excluded from exact search.</p>}
      <details className="combination-scope"><summary>Search scope</summary><p>Completed, unallocated receipts with this invoice reference or customer key. Conflicting references, rejected associations and receipts larger than the remaining amount are excluded. Gross amounts are compared exactly in cents; fees stay separate. A result only selects receipts for your review.</p><p>{result.candidateCount} receipts in scope{result.status === "complete" ? ` · ${result.statesExamined.toLocaleString("en-US")} partial sums checked` : ""}.</p></details>
    </div>
  </details>;
}
