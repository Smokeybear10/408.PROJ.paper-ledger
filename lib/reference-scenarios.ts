import { investigationRequestSchema, type InvestigationRequest, type Proposal } from "./contracts";

type ChallengeNote = { label: string; text: string; expected: Proposal["category"]; invoiceId: string | null };
export type ReferenceScenario = {
  id: string;
  title: string;
  description: string;
  amountMinor: number;
  feeMinor: number;
  paymentId: string;
  invoiceReference: string | null;
  invoices: { id: string; description: string; dueDate: string }[];
  notes: ChallengeNote[];
};

export const REFERENCE_SCENARIOS: ReferenceScenario[] = [
  {
    id: "correction",
    title: "A correction changes the match",
    description: "Two equal invoices. The sender corrects an earlier payment instruction.",
    amountMinor: 125000,
    feeMinor: 4400,
    paymentId: "TEST-PAY-620",
    invoiceReference: null,
    invoices: [
      { id: "INV-6201", description: "Annual technical support renewal", dueDate: "2026-11-02" },
      { id: "INV-6202", description: "Hardware maintenance project balance", dueDate: "2026-11-02" },
    ],
    notes: [
      { label: "Correction to maintenance", text: "I wrote annual support renewal in my earlier message. Correction: this transfer clears the hardware maintenance project balance. The support renewal is still outstanding.", expected: "reference_interpretation", invoiceId: "INV-6202" },
      { label: "Reverse the correction", text: "My earlier message said hardware maintenance. Correction: this payment is for the annual technical support renewal. Do not apply it to the maintenance project balance.", expected: "reference_interpretation", invoiceId: "INV-6201" },
      { label: "Remove identifying details", text: "Here is the $1,250 we discussed. Please apply it to the outstanding invoice. Thanks.", expected: "ambiguous", invoiceId: null },
    ],
  },
  {
    id: "reference-conflict",
    title: "The reference and note disagree",
    description: "A structured reference points to one invoice; the sender's note describes another.",
    amountMinor: 98000,
    feeMinor: 3480,
    paymentId: "TEST-PAY-810",
    invoiceReference: "INV-8101",
    invoices: [
      { id: "INV-8101", description: "Software license renewal", dueDate: "2026-11-03" },
      { id: "INV-8102", description: "Data migration implementation balance", dueDate: "2026-11-03" },
    ],
    notes: [
      { label: "Conflicting reference", text: "The invoice field incorrectly says INV-8101. This payment is for the data migration implementation balance, not the software license renewal. Please check the reference before applying it.", expected: "ambiguous", invoiceId: null },
      { label: "Consistent reference", text: "Payment for INV-8101, the software license renewal. The data migration implementation balance will be paid separately.", expected: "reference_interpretation", invoiceId: "INV-8101" },
    ],
  },
  {
    id: "insufficient-evidence",
    title: "Sometimes the answer is unknown",
    description: "Matching amount and customer are not enough to identify the intended invoice.",
    amountMinor: 72000,
    feeMinor: 2570,
    paymentId: "TEST-PAY-730",
    invoiceReference: null,
    invoices: [
      { id: "INV-7301", description: "Quarterly security assessment", dueDate: "2026-11-04" },
      { id: "INV-7302", description: "Archived data storage renewal", dueDate: "2026-11-04" },
    ],
    notes: [
      { label: "Not enough information", text: "Sending the $720 from our conversation. Please mark the right invoice. Thanks.", expected: "ambiguous", invoiceId: null },
      { label: "Add a specific purpose", text: "This transfer covers the archived data storage renewal. We have not approved the quarterly security assessment for payment yet.", expected: "reference_interpretation", invoiceId: "INV-7302" },
    ],
  },
];

export function buildReferenceChallenge(scenario: ReferenceScenario, note: string, requestId: string): InvestigationRequest {
  const context = {
    caseId: scenario.invoices[0].id,
    invoices: scenario.invoices.map((invoice) => ({ id: invoice.id, amountMinor: scenario.amountMinor, currency: "USD" as const, dueDate: invoice.dueDate, customerGroup: "group-1", context: invoice.description })),
    payments: [{ id: scenario.paymentId, grossMinor: scenario.amountMinor, feeMinor: scenario.feeMinor, netMinor: scenario.amountMinor - scenario.feeMinor, currency: "USD" as const, invoiceId: scenario.invoiceReference, status: "completed" as const, kind: "receipt" as const, eventCode: "T0006", customerGroup: "group-1" }],
    excerpt: note.trim(),
    excerptPaymentId: scenario.paymentId,
  };
  return investigationRequestSchema.parse({ ...context, requestId, fingerprint: JSON.stringify({ purpose: "synthetic-reference-challenge", scenario: scenario.id, ...context }) });
}
