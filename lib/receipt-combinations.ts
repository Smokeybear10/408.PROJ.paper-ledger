import type { Dataset, Payment, ReviewState } from "./contracts";
import { linkedAdjustment, reconcile } from "./reconciliation";

export const MAX_COMBINATION_CANDIDATES = 24;
export const MAX_DISPLAYED_COMBINATIONS = 10;

export type ReceiptCombination = {
  paymentIds: string[];
  grossMinor: number;
  competingInvoiceIds: string[];
};

export type ReceiptCombinationResult = {
  status: "complete" | "limit" | "settled" | "missing";
  targetMinor: number;
  candidateCount: number;
  excludedAdjustmentCount: number;
  combinations: ReceiptCombination[];
  totalCombinations: number;
  statesExamined: number;
};

type Subset = { sum: number; mask: number };

function subsets(payments: Payment[], target: number): Subset[] {
  const result: Subset[] = [{ sum: 0, mask: 0 }];
  payments.forEach((payment, index) => {
    const length = result.length;
    for (let previous = 0; previous < length; previous += 1) {
      const sum = result[previous].sum + payment.grossMinor;
      if (sum <= target) result.push({ sum, mask: result[previous].mask | (1 << index) });
    }
  });
  return result;
}

function bySum(values: Subset[]): Map<number, Subset[]> {
  const groups = new Map<number, Subset[]>();
  values.forEach((subset) => {
    const group = groups.get(subset.sum);
    if (group) group.push(subset);
    else groups.set(subset.sum, [subset]);
  });
  return groups;
}

const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function findReceiptCombinations(dataset: Dataset, review: ReviewState, invoiceId: string): ReceiptCombinationResult {
  const reconciliation = reconcile(dataset, review);
  const row = reconciliation.rows.find((result) => result.invoice.id === invoiceId);
  const empty: ReceiptCombinationResult = { status: "missing", targetMinor: 0, candidateCount: 0, excludedAdjustmentCount: 0, combinations: [], totalCombinations: 0, statesExamined: 0 };
  if (!row) return empty;
  const targetMinor = Math.max(0, row.invoice.amountMinor - row.confirmedGrossMinor);
  if (!targetMinor) return { ...empty, status: "settled" };

  const unallocated = new Set(reconciliation.unallocatedPayments.map((payment) => payment.id));
  const related = row.candidatePayments.filter((candidate) => candidate.eligible && candidate.match !== "amount" && unallocated.has(candidate.payment.id) && candidate.payment.grossMinor <= targetMinor).map((candidate) => candidate.payment);
  const payments = related.filter((receipt) => !dataset.payments.some((payment) => linkedAdjustment(payment, receipt))).sort((a, b) => compareIds(a.id, b.id));
  const base: ReceiptCombinationResult = { ...empty, status: "complete", targetMinor, candidateCount: payments.length, excludedAdjustmentCount: related.length - payments.length };
  if (payments.length > MAX_COMBINATION_CANDIDATES) return { ...base, status: "limit" };
  if (!payments.length) return base;

  const middle = Math.floor(payments.length / 2);
  const leftPayments = payments.slice(0, middle);
  const rightPayments = payments.slice(middle);
  const left = subsets(leftPayments, targetMinor);
  const right = subsets(rightPayments, targetMinor);
  const leftGroups = bySum(left);
  const rightGroups = bySum(right);
  let totalCombinations = 0;
  leftGroups.forEach((group, sum) => { totalCombinations += group.length * (rightGroups.get(targetMinor - sum)?.length ?? 0); });

  const competing = new Map<string, Set<string>>();
  const candidateIds = new Set(payments.map((payment) => payment.id));
  reconciliation.rows.forEach((other) => {
    if (other.invoice.id === invoiceId) return;
    other.candidatePayments.forEach((candidate) => {
      if (!candidate.eligible || !candidateIds.has(candidate.payment.id)) return;
      const invoices = competing.get(candidate.payment.id) ?? new Set<string>();
      invoices.add(other.invoice.id);
      competing.set(candidate.payment.id, invoices);
    });
  });

  const combinations: ReceiptCombination[] = [];
  for (const rightSubset of right) {
    const matches = leftGroups.get(targetMinor - rightSubset.sum) ?? [];
    for (const leftSubset of matches) {
      const paymentIds = [...leftPayments.filter((_, index) => leftSubset.mask & (1 << index)), ...rightPayments.filter((_, index) => rightSubset.mask & (1 << index))].map((payment) => payment.id);
      combinations.push({ paymentIds, grossMinor: targetMinor, competingInvoiceIds: [...new Set(paymentIds.flatMap((id) => [...(competing.get(id) ?? [])]))].sort(compareIds) });
      if (combinations.length === MAX_DISPLAYED_COMBINATIONS) break;
    }
    if (combinations.length === MAX_DISPLAYED_COMBINATIONS) break;
  }
  return { ...base, combinations, totalCombinations, statesExamined: left.length + right.length };
}
