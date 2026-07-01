import type { Dataset, Reconciliation, ReviewState, SourceInfo } from "../lib/contracts";
import type { AssociationPreview, ExceptionDesk } from "../lib/case-intelligence";
import { buildReviewImpact } from "../lib/review-impact";
import { formatMoney, reconcile } from "../lib/reconciliation";

type ImpactProps = {
  dataset: Dataset;
  review: ReviewState;
  invoiceId: string;
  paymentIds: string[];
  preview?: AssociationPreview;
  reconciliation?: Reconciliation;
};

type OverviewProps = {
  dataset: Dataset;
  review: ReviewState;
  reconciliation: Reconciliation;
  desk: ExceptionDesk;
};

function verification(source: SourceInfo | null): string {
  if (!source) return "No records loaded";
  if (source.kind === "sample") return "Synthetic sample · unverified";
  if (source.kind === "paypal" && source.providerVerified) return "Returned sandbox records verified";
  return source.kind === "file" ? "Imported file · unverified" : "Sandbox source · unverified";
}

export function ReviewOverview({ dataset, review, reconciliation, desk }: OverviewProps) {
  const { invoiceCount, coveredCount, confirmedGrossMinor } = reconciliation.stats;
  const openCount = invoiceCount - coveredCount;

  return <section className="review-overview" aria-label="Review progress">
    <h2 className="sr-only">Review progress</h2>
    <dl className="overview-metrics">
      <div className="overview-metric overview-metric-coverage">
        <dt>Invoices covered</dt>
        <dd><span className="overview-value">{coveredCount}<span className="overview-total"> of {invoiceCount}</span></span><span className="overview-subtext">{openCount} {openCount === 1 ? "invoice" : "invoices"} to review</span></dd>
      </div>
      <div className="overview-metric overview-metric-confirmed">
        <dt>Confirmed gross</dt>
        <dd className="overview-value">{formatMoney(confirmedGrossMinor)}</dd>
      </div>
      <div className="overview-metric overview-metric-unallocated">
        <dt>Unallocated gross</dt>
        <dd className="overview-value">{formatMoney(desk.unallocatedGrossMinor)}</dd>
      </div>
    </dl>
    <div className="overview-secondary">
      <p className="overview-exception-totals"><span>Pending <strong>{formatMoney(desk.pendingGrossMinor)}</strong> <small>excluded</small></span><span>Refunds & reversals <strong>{formatMoney(desk.adjustmentGrossMinor)}</strong></span><span>{desk.findings.length} {desk.findings.length === 1 ? "finding" : "findings"}</span></p>
      <details className="overview-source-details"><summary>Review scope</summary><p>{review.allocations.length} human {review.allocations.length === 1 ? "allocation" : "allocations"}. {desk.unallocatedReceiptCount} eligible {desk.unallocatedReceiptCount === 1 ? "receipt" : "receipts"} await allocation; gross is counted once.</p><p><strong>Invoices:</strong> {verification(dataset.invoiceSource)}<br /><strong>Payments:</strong> {verification(dataset.paymentSource)}</p><p>Totals describe loaded records. They do not establish available cash or complete account history.</p></details>
    </div>
  </section>;
}

export default function ReviewImpact({ dataset, review, invoiceId, paymentIds, preview, reconciliation }: ImpactProps) {
  if (!paymentIds.length) return null;
  const currentReconciliation = reconciliation ?? reconcile(dataset, review);
  const row = currentReconciliation.rows.find((result) => result.invoice.id === invoiceId);
  const impact = buildReviewImpact(dataset, review, invoiceId, paymentIds, preview, currentReconciliation);
  const showWarning = impact.valid && (impact.hasRefundAfter || Boolean(row && impact.confirmedAfterMinor > row.invoice.amountMinor));

  return <section className={`impact-panel${impact.valid ? "" : " impact-invalid"}`} aria-label="Allocation impact">
    <div className="impact-heading"><p>If you confirm</p><span>Preview · not applied</span></div>
    {impact.valid ? <>
      <dl className="impact-metrics">
        <div className="impact-metric"><dt>Confirmed gross</dt><dd className="impact-value"><span>{formatMoney(impact.confirmedBeforeMinor)}</span><span className="impact-arrow" aria-label="would become">→</span><strong>{formatMoney(impact.confirmedAfterMinor)}</strong></dd></div>
        <div className="impact-metric"><dt>Unallocated gross</dt><dd className="impact-value"><span>{formatMoney(impact.unallocatedBeforeMinor)}</span><span className="impact-arrow" aria-label="would become">→</span><strong>{formatMoney(impact.unallocatedAfterMinor)}</strong></dd></div>
        <div className="impact-metric"><dt>Remaining amount</dt><dd className="impact-value"><strong>{formatMoney(impact.remainingAfterMinor)}</strong></dd></div>
      </dl>
      {showWarning && <p className="impact-warning" role="status">{impact.message}</p>}
      {impact.affectedInvoiceIds.length > 0 && <div className="impact-related"><p><strong>{impact.affectedInvoiceIds.length} other {impact.affectedInvoiceIds.length === 1 ? "invoice" : "invoices"}</strong> would lose this candidate{impact.affectedInvoiceIds.length <= 3 && <> · <strong>{impact.affectedInvoiceIds.join(", ")}</strong></>}</p>{impact.affectedInvoiceIds.length > 3 && <details><summary>Show affected invoice IDs</summary><p>{impact.affectedInvoiceIds.join(", ")}</p></details>}</div>}
      <details className="impact-calculation"><summary>Calculation details</summary>{!showWarning && <p className="impact-effect">{impact.message}</p>}<p className="impact-footnote">{impact.newlyAllocatedReceiptCount} {impact.newlyAllocatedReceiptCount === 1 ? "receipt" : "receipts"} newly allocated · gross counted once. Fees, source records and provider verification stay separate.</p></details>
    </> : <p className="impact-effect" role="status">{impact.message}</p>}
  </section>;
}
