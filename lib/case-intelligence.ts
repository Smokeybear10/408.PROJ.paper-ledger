import type { Dataset, Payment, ReviewState } from "./contracts";
import { confirmAllocation, formatMoney, isEligibleReceipt, reconcile } from "./reconciliation";

export type TriageFinding = {
  id: string;
  kind: "competing-receipt" | "refund" | "partial" | "pending" | "overpayment" | "missing-receipt" | "unsupported";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  nextStep: string;
  invoiceIds: string[];
  paymentIds: string[];
  evidenceIds: string[];
};

export type ExceptionDesk = {
  findings: TriageFinding[];
  unallocatedReceiptCount: number;
  unallocatedGrossMinor: number;
  pendingGrossMinor: number;
  adjustmentGrossMinor: number;
};

export type AssociationPreview = {
  valid: boolean;
  message: string;
  confirmedBeforeMinor: number;
  confirmedAfterMinor: number;
  remainingAfterMinor: number;
  affectedInvoiceIds: string[];
};

function total(values: number[]): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(sum + value)) throw new Error("An exception amount exceeds the supported integer range.");
    return sum + value;
  }, 0);
}

const ordered = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const invoiceReference = (payment: Payment) => payment.invoiceId?.trim() ?? "";
const isAdjustment = (payment: Payment) => payment.kind === "refund" || payment.kind === "reversal";
const hasRefundStatus = (payment: Payment) => payment.status === "refunded" || payment.status === "partially_refunded" || payment.status === "reversed";

function finding(value: Omit<TriageFinding, "evidenceIds">): TriageFinding {
  const invoiceIds = ordered(value.invoiceIds);
  const paymentIds = ordered(value.paymentIds);
  return { ...value, invoiceIds, paymentIds, evidenceIds: [...invoiceIds.map((id) => `invoice:${id}`), ...paymentIds.map((id) => `payment:${id}`)] };
}

function addLink(index: Map<string, Set<string>>, paymentId: string, invoiceId: string): void {
  const invoiceIds = index.get(paymentId) ?? new Set<string>();
  invoiceIds.add(invoiceId);
  index.set(paymentId, invoiceIds);
}

type RefundGroup = { invoiceIds: Set<string>; paymentIds: Set<string>; adjustmentIds: Set<string>; flaggedReceiptIds: Set<string> };

export function buildExceptionDesk(dataset: Dataset, review: ReviewState): ExceptionDesk {
  const reconciliation = reconcile(dataset, review);
  const invoiceIds = new Set(dataset.invoices.map((invoice) => invoice.id));
  const paymentMap = new Map(dataset.payments.map((payment) => [payment.id, payment]));
  const unallocated = new Map(reconciliation.unallocatedPayments.map((payment) => [payment.id, payment]));
  const candidatesByReceipt = new Map<string, Set<string>>();
  const evidenceInvoices = new Map<string, Set<string>>();
  const receiptsByProvider = new Map<string, Payment[]>();
  const findings: TriageFinding[] = [];

  dataset.payments.forEach((payment) => {
    if (payment.kind === "receipt") receiptsByProvider.set(payment.providerId, [...(receiptsByProvider.get(payment.providerId) ?? []), payment]);
    if (invoiceIds.has(invoiceReference(payment))) addLink(evidenceInvoices, payment.id, invoiceReference(payment));
  });
  reconciliation.rows.forEach((row) => {
    row.candidatePayments.forEach((candidate) => {
      addLink(evidenceInvoices, candidate.payment.id, row.invoice.id);
      if (candidate.eligible && unallocated.has(candidate.payment.id)) addLink(candidatesByReceipt, candidate.payment.id, row.invoice.id);
    });
    row.confirmedPayments.forEach((payment) => addLink(evidenceInvoices, payment.id, row.invoice.id));
  });

  candidatesByReceipt.forEach((possibleInvoices, paymentId) => {
    if (possibleInvoices.size < 2) return;
    const payment = paymentMap.get(paymentId);
    if (!payment) return;
    findings.push(finding({
      id: `competing-receipt:${paymentId}`, kind: "competing-receipt", priority: "high", title: "One receipt has competing invoices",
      description: `${paymentId}, gross ${formatMoney(payment.grossMinor)}, is an unallocated candidate for ${possibleInvoices.size} invoices in the current reconciliation. Its amount is counted once in unallocated receipts.`,
      nextStep: "Inspect the reference and source evidence, then confirm at most one invoice association.",
      invoiceIds: [...possibleInvoices], paymentIds: [paymentId],
    }));
  });

  const refundGroups = new Map<string, RefundGroup>();
  const refundGroup = (key: string) => {
    const group = refundGroups.get(key) ?? { invoiceIds: new Set<string>(), paymentIds: new Set<string>(), adjustmentIds: new Set<string>(), flaggedReceiptIds: new Set<string>() };
    refundGroups.set(key, group);
    return group;
  };
  dataset.payments.forEach((payment) => {
    if (payment.kind === "receipt" && hasRefundStatus(payment)) {
      const group = refundGroup(`transaction:${payment.providerId}`);
      group.paymentIds.add(payment.id);
      group.flaggedReceiptIds.add(payment.id);
      evidenceInvoices.get(payment.id)?.forEach((id) => group.invoiceIds.add(id));
    }
    if (!isAdjustment(payment)) return;
    const transactionId = payment.referenceType === "TXN" ? payment.referenceId?.trim() : null;
    const group = refundGroup(transactionId ? `transaction:${transactionId}` : `adjustment:${payment.id}`);
    group.paymentIds.add(payment.id);
    group.adjustmentIds.add(payment.id);
    if (invoiceIds.has(invoiceReference(payment))) group.invoiceIds.add(invoiceReference(payment));
    if (transactionId) (receiptsByProvider.get(transactionId) ?? []).forEach((receipt) => {
      group.paymentIds.add(receipt.id);
      evidenceInvoices.get(receipt.id)?.forEach((id) => group.invoiceIds.add(id));
    });
  });
  refundGroups.forEach((group, key) => {
    const adjustments = [...group.adjustmentIds].flatMap((id) => paymentMap.get(id) ?? []);
    const adjustmentGross = total(adjustments.map((payment) => payment.grossMinor));
    const recordDescription = adjustments.length
      ? `${adjustments.length} refund/reversal record${adjustments.length === 1 ? " has" : "s have"} signed gross ${formatMoney(adjustmentGross)}; recorded state${adjustments.length === 1 ? "" : "s"}: ${ordered(adjustments.map((payment) => payment.status)).join(", ")}.`
      : `${ordered(group.flaggedReceiptIds).join(", ")} carries a refunded, partially refunded or reversed status. No adjustment total is inferred.`;
    findings.push(finding({
      id: `refund:${key}`, kind: "refund", priority: "high", title: "Refund or reversal evidence needs review",
      description: `${recordDescription} This evidence prevents a simple covered conclusion for an associated invoice.`,
      nextStep: group.invoiceIds.size ? "Inspect the original receipt and adjustment evidence before completing the invoice review." : "Find the original transaction and verify the invoice association for this adjustment.",
      invoiceIds: [...group.invoiceIds], paymentIds: [...group.paymentIds],
    }));
  });

  const pendingPayments = dataset.payments.filter((payment) => payment.kind === "receipt" && payment.status === "pending" && payment.currency === "USD" && payment.grossMinor > 0);
  const pendingInvoices = new Set<string>();
  pendingPayments.forEach((payment) => {
    const linkedInvoices = [...(evidenceInvoices.get(payment.id) ?? [])];
    linkedInvoices.forEach((id) => pendingInvoices.add(id));
    findings.push(finding({
      id: `pending:${payment.id}`, kind: "pending", priority: "low", title: "Receipt is still pending",
      description: `${payment.id} records pending gross ${formatMoney(payment.grossMinor)}. It contributes no confirmed settled receipt amount.`,
      nextStep: "Check the provider status before treating this receipt as completed.", invoiceIds: linkedInvoices, paymentIds: [payment.id],
    }));
  });

  const unsupportedInvoices = new Set<string>();
  dataset.payments.filter((payment) => payment.status === "unsupported" || payment.kind === "other" || (payment.kind === "receipt" && payment.status === "completed" && !isEligibleReceipt(payment))).forEach((payment) => {
    const linkedInvoices = [...(evidenceInvoices.get(payment.id) ?? [])];
    linkedInvoices.forEach((id) => unsupportedInvoices.add(id));
    findings.push(finding({
      id: `unsupported:${payment.id}`, kind: "unsupported", priority: "medium", title: "Transaction semantics are unsupported",
      description: `${payment.id}, event ${payment.eventCode || "not supplied"}, is retained as evidence and cannot establish invoice coverage.`,
      nextStep: "Inspect the source event and import mapping before making an association.", invoiceIds: linkedInvoices, paymentIds: [payment.id],
    }));
  });

  const refundInvoices = new Set([...refundGroups.values()].flatMap((group) => [...group.invoiceIds]));
  reconciliation.rows.forEach((row) => {
    const directCandidates = row.candidatePayments.filter((candidate) => candidate.match === "reference" && candidate.eligible && unallocated.has(candidate.payment.id));
    const directGross = total(directCandidates.map((candidate) => candidate.payment.grossMinor));
    const possibleGross = total([row.confirmedGrossMinor, directGross]);
    const confirmedPaymentIds = row.confirmedPayments.map((payment) => payment.id);
    const referencedPaymentIds = directCandidates.map((candidate) => candidate.payment.id);
    if (possibleGross > row.invoice.amountMinor) {
      const confirmedOverpayment = row.confirmedGrossMinor > row.invoice.amountMinor;
      const overpaymentGross = confirmedOverpayment ? row.confirmedGrossMinor : possibleGross;
      findings.push(finding({
        id: `overpayment:${row.invoice.id}`, kind: "overpayment", priority: confirmedOverpayment ? "high" : "medium", title: confirmedOverpayment ? "Confirmed gross exceeds the invoice" : "Unreviewed overpayment candidate",
        description: `${confirmedOverpayment ? "Confirmed allocations total" : "Confirmed allocations plus directly referenced unreviewed receipts total"} ${formatMoney(overpaymentGross)} against ${row.invoice.id} at ${formatMoney(row.invoice.amountMinor)}; the difference is ${formatMoney(total([overpaymentGross, -row.invoice.amountMinor]))}.`,
        nextStep: "Review each referenced receipt and the invoice amount before resolving the excess.", invoiceIds: [row.invoice.id], paymentIds: [...confirmedPaymentIds, ...referencedPaymentIds],
      }));
    } else if (row.confirmedGrossMinor > 0 && row.confirmedGrossMinor < row.invoice.amountMinor) {
      findings.push(finding({
        id: `partial:${row.invoice.id}`, kind: "partial", priority: "medium", title: "Confirmed partial allocation",
        description: `${row.invoice.id} has confirmed gross ${formatMoney(row.confirmedGrossMinor)} of ${formatMoney(row.invoice.amountMinor)}. The remaining ${formatMoney(total([row.invoice.amountMinor, -row.confirmedGrossMinor]))} has no confirmed allocation in the loaded data.`,
        nextStep: "Review any remaining receipt evidence before completing this invoice’s reconciliation.", invoiceIds: [row.invoice.id], paymentIds: [...confirmedPaymentIds, ...referencedPaymentIds],
      }));
    } else if (row.confirmedGrossMinor === 0 && directGross > 0 && directGross < row.invoice.amountMinor) {
      findings.push(finding({
        id: `partial:${row.invoice.id}`, kind: "partial", priority: "medium", title: "Unreviewed partial candidate",
        description: `Directly referenced receipts total ${formatMoney(directGross)} against ${row.invoice.id} at ${formatMoney(row.invoice.amountMinor)}. No allocation is confirmed; this is a candidate for review.`,
        nextStep: "Inspect and confirm the referenced receipts before describing the invoice as partially reconciled.", invoiceIds: [row.invoice.id], paymentIds: referencedPaymentIds,
      }));
    }
    const availableReceiptEvidence = row.candidatePayments.some((candidate) => candidate.eligible);
    if (row.confirmedGrossMinor === 0 && !availableReceiptEvidence && !pendingInvoices.has(row.invoice.id) && !refundInvoices.has(row.invoice.id) && !unsupportedInvoices.has(row.invoice.id)) {
      findings.push(finding({
        id: `missing-receipt:${row.invoice.id}`, kind: "missing-receipt", priority: "low", title: "No eligible receipt in loaded data",
        description: `${row.invoice.id} has no confirmed allocation or eligible candidate within the current data and review decisions. This does not prove the invoice is unpaid.`,
        nextStep: "Check the imported date range and source records for a receipt before drawing a payment conclusion.", invoiceIds: [row.invoice.id], paymentIds: row.candidatePayments.map((candidate) => candidate.payment.id),
      }));
    }
  });

  const priorityRank = { high: 0, medium: 1, low: 2 };
  const kindRank = { "competing-receipt": 0, refund: 1, overpayment: 2, partial: 3, unsupported: 4, pending: 5, "missing-receipt": 6 };
  findings.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || kindRank[a.kind] - kindRank[b.kind] || a.id.localeCompare(b.id));
  return {
    findings,
    unallocatedReceiptCount: unallocated.size,
    unallocatedGrossMinor: total([...unallocated.values()].map((payment) => payment.grossMinor)),
    pendingGrossMinor: total(pendingPayments.map((payment) => payment.grossMinor)),
    adjustmentGrossMinor: total(dataset.payments.filter(isAdjustment).map((payment) => payment.grossMinor)),
  };
}

export function previewAssociation(dataset: Dataset, review: ReviewState, invoiceId: string, paymentIds: string[]): AssociationPreview {
  let confirmedBeforeMinor = 0;
  let remainingBeforeMinor = 0;
  try {
    const before = reconcile(dataset, review);
    const invoice = before.rows.find((row) => row.invoice.id === invoiceId);
    if (!invoice) throw new Error("The selected invoice is no longer available.");
    confirmedBeforeMinor = invoice.confirmedGrossMinor;
    remainingBeforeMinor = Math.max(0, total([invoice.invoice.amountMinor, -confirmedBeforeMinor]));
    const simulatedReview = confirmAllocation(dataset, review, invoiceId, paymentIds);
    const after = reconcile(dataset, simulatedReview);
    const result = after.rows.find((row) => row.invoice.id === invoiceId);
    if (!result) throw new Error("The selected invoice is no longer available.");
    const selectedIds = new Set(paymentIds);
    const afterRows = new Map(after.rows.map((row) => [row.invoice.id, row]));
    const affectedInvoiceIds = before.rows.filter((row) => row.invoice.id !== invoiceId && row.candidatePayments.some((candidate) => candidate.eligible && selectedIds.has(candidate.payment.id) && !afterRows.get(row.invoice.id)?.candidatePayments.some((remaining) => remaining.payment.id === candidate.payment.id))).map((row) => row.invoice.id);
    const remainingAfterMinor = Math.max(0, total([invoice.invoice.amountMinor, -result.confirmedGrossMinor]));
    const excess = Math.max(0, total([result.confirmedGrossMinor, -invoice.invoice.amountMinor]));
    const message = simulatedReview === review
      ? "These receipts are already confirmed for this invoice."
      : excess > 0
        ? `Confirmed gross would be ${formatMoney(result.confirmedGrossMinor)}, exceeding the invoice by ${formatMoney(excess)}. The overpayment remains an exception.`
        : result.status === "refund"
          ? `Confirmed gross would be ${formatMoney(result.confirmedGrossMinor)}. Refund or reversal evidence keeps this case in review.`
          : remainingAfterMinor === 0
            ? `Confirmed gross would equal the invoice amount of ${formatMoney(result.confirmedGrossMinor)}. Fees remain separate from invoice coverage.`
            : `Confirmed gross would be ${formatMoney(result.confirmedGrossMinor)}; ${formatMoney(remainingAfterMinor)} would remain without a confirmed allocation in the loaded data.`;
    return { valid: true, message, confirmedBeforeMinor, confirmedAfterMinor: result.confirmedGrossMinor, remainingAfterMinor, affectedInvoiceIds: ordered(affectedInvoiceIds) };
  } catch (error) {
    return { valid: false, message: error instanceof Error ? error.message : "This association cannot be confirmed from the available evidence.", confirmedBeforeMinor, confirmedAfterMinor: confirmedBeforeMinor, remainingAfterMinor: remainingBeforeMinor, affectedInvoiceIds: [] };
  }
}
