import type { Dataset, Reconciliation, ReviewState } from "./contracts";
import { previewAssociation, type AssociationPreview } from "./case-intelligence";
import { reconcile } from "./reconciliation";

export type ReviewImpactResult = AssociationPreview & {
  unallocatedBeforeMinor: number;
  unallocatedAfterMinor: number;
  newlyAllocatedReceiptCount: number;
};

export function buildReviewImpact(
  dataset: Dataset,
  review: ReviewState,
  invoiceId: string,
  paymentIds: string[],
  preview = previewAssociation(dataset, review, invoiceId, paymentIds),
  reconciliation: Reconciliation = reconcile(dataset, review),
): ReviewImpactResult {
  const selectedIds = new Set(paymentIds);
  const newlyAllocated = preview.valid ? reconciliation.unallocatedPayments.filter((payment) => selectedIds.has(payment.id)) : [];
  const unallocatedBeforeMinor = reconciliation.unallocatedPayments.reduce((sum, payment) => sum + payment.grossMinor, 0);
  const allocatedMinor = newlyAllocated.reduce((sum, payment) => sum + payment.grossMinor, 0);

  return {
    ...preview,
    unallocatedBeforeMinor,
    unallocatedAfterMinor: unallocatedBeforeMinor - allocatedMinor,
    newlyAllocatedReceiptCount: newlyAllocated.length,
  };
}
