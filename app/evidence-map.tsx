import { useState, type CSSProperties } from "react";
import type { CandidatePayment, Dataset, InvestigationResponse, InvoiceResult, Payment, Reconciliation, SourceInfo } from "../lib/contracts";
import { formatMoney, isEligibleReceipt, linkedAdjustment } from "../lib/reconciliation";

type Props = {
  dataset: Dataset;
  reconciliation: Reconciliation;
  invoiceId: string;
  payment: Payment | null;
  analysis: InvestigationResponse | null;
  historical: boolean;
  busy: boolean;
  onInvoice: (id: string) => void;
  onCompare?: () => void;
};

type Connection = { row: InvoiceResult; candidate: CandidatePayment | undefined; confirmed: boolean };
type ConnectionState = "candidate" | "confirmed" | "model" | "ineligible";

const MAX_TARGETS = 4;
const sameKey = (left: string | null, right: string | null) => Boolean(left?.trim() && right?.trim() && left.trim().toLowerCase() === right.trim().toLowerCase());

function provenance(source: SourceInfo | null): string {
  if (source?.kind === "sample") return "Synthetic sample";
  if (source?.kind === "paypal" && source.providerVerified) return "Sandbox observation";
  if (source?.kind === "file") return "Imported · unverified";
  return "Source unverified";
}

function stateLabel(state: ConnectionState): string {
  if (state === "confirmed") return "Human confirmed";
  if (state === "model") return "AI interpretation · unconfirmed";
  if (state === "ineligible") return "Evidence only · cannot allocate";
  return "Candidate · unconfirmed";
}

export default function EvidenceMap({ dataset, reconciliation, invoiceId, payment, analysis, historical, busy, onInvoice, onCompare }: Props) {
  const [inspection, setInspection] = useState<{ paymentId: string; selectedId: string; invoiceId: string } | null>(null);

  if (!payment) return <section className="evidence-map evidence-map-empty" id="evidence-map" aria-label="Evidence map"><div className="evidence-map-heading"><div><p className="eyebrow">EVIDENCE MAP</p><h3>Follow the payment</h3><p>Select a receipt to trace its source and invoice relationships. No receipt in the loaded data does not establish that an invoice is unpaid.</p></div></div></section>;

  const related: Connection[] = reconciliation.rows.flatMap((row) => {
    const candidate = row.candidatePayments.find((item) => item.payment.id === payment.id);
    const confirmed = row.confirmedPayments.some((item) => item.id === payment.id);
    return candidate || confirmed ? [{ row, candidate, confirmed }] : [];
  });
  const owner = related.find((connection) => connection.confirmed)?.row.invoice.id ?? null;
  const eligible = isEligibleReceipt(payment);
  const proposal = analysis?.proposal;
  const supportedProposal = proposal?.category === "reference_interpretation" && proposal.paymentIds.includes(payment.id) && proposal.invoiceId && related.some(({ row, candidate, confirmed }) => row.invoice.id === proposal.invoiceId && (confirmed || candidate?.eligible)) && (!owner || owner === proposal.invoiceId);
  const suggestedId = supportedProposal && !historical ? proposal.invoiceId : null;
  const stateOf = (connection: Connection): ConnectionState => connection.confirmed ? "confirmed" : !eligible || connection.candidate?.eligible === false || Boolean(owner) ? "ineligible" : connection.row.invoice.id === suggestedId ? "model" : "candidate";
  const rank = (connection: Connection) => connection.row.invoice.id === invoiceId ? 0 : connection.confirmed ? 1 : connection.row.invoice.id === suggestedId ? 2 : 3;
  const ordered = [...related].sort((left, right) => rank(left) - rank(right) || left.row.invoice.id.localeCompare(right.row.invoice.id));
  const visible = ordered.slice(0, MAX_TARGETS);
  const inspectedId = inspection?.paymentId === payment.id && inspection.selectedId === invoiceId ? inspection.invoiceId : null;
  const inspected = visible.find(({ row }) => row.invoice.id === inspectedId) ?? null;
  const adjustments = dataset.payments.filter((record) => record.id !== payment.id && linkedAdjustment(record, payment));
  const source = dataset.paymentSource;
  const providerVerified = source?.kind === "paypal" && source.providerVerified;
  const selectedIsRelated = related.some(({ row }) => row.invoice.id === invoiceId);
  const analysisRelates = Boolean(analysis && (proposal?.category !== "reference_interpretation" || supportedProposal));
  const invoiceSource = dataset.invoiceSource;
  const branchStyle = { "--evidence-branches": Math.max(1, visible.length) } as CSSProperties;

  return <section className="evidence-map" id="evidence-map" aria-label="Evidence map">
    <header className="evidence-map-heading"><div><p className="eyebrow">EVIDENCE MAP</p><h3>Trace this payment’s invoice paths</h3><p>{owner ? `The reviewed association belongs to ${owner}.` : !eligible ? "This record is retained as evidence and cannot establish settled coverage." : related.length > 1 ? "Compare the source with each invoice. Only your confirmation allocates the receipt." : related.length === 1 ? "A matching relationship is available for your review." : "No available invoice relationship exists in the current reconciliation."}</p></div><span className="evidence-map-count">{related.length} {related.length === 1 ? "relationship" : "relationships"}</span></header>
    <div className="evidence-map-legend" aria-label="Connection legend"><span data-kind="candidate">Unconfirmed relationship</span><span data-kind="confirmed">Human confirmed</span>{suggestedId && <span data-kind="model">AI interpretation</span>}</div>
    <div className="evidence-map-canvas">
      <div className="evidence-map-origin">
        <div className="evidence-node evidence-node-receipt">
          <div className="evidence-node-topline"><span className="evidence-node-kind">{payment.kind === "receipt" ? "Payment source" : `${payment.kind} record`}</span><span className="evidence-node-provenance" data-verified={providerVerified ? "true" : "false"}>{provenance(source)}</span></div>
          <h4>{payment.id}</h4><strong className="evidence-node-amount">{formatMoney(payment.grossMinor)}</strong><span className="evidence-node-status">{payment.status.replaceAll("_", " ")} · {payment.currency} gross</span>
          <dl className="evidence-node-money"><div><dt>Fee cost</dt><dd>{payment.feeMinor === null ? "Unknown" : formatMoney(payment.feeMinor)}</dd></div><div><dt>Net</dt><dd>{payment.netMinor === null ? "Unknown" : formatMoney(payment.netMinor)}</dd></div></dl>
          <div className="evidence-node-memo"><span>Remittance</span>{payment.memo.trim() ? <blockquote>{payment.memo}</blockquote> : <p>No remittance supplied</p>}</div>
          <details className="evidence-node-source"><summary>Inspect full source</summary><dl><div><dt>Collection</dt><dd>{source?.label ?? "Not recorded"}</dd></div><div><dt>Provider ID</dt><dd>{payment.providerId}</dd></div><div><dt>Source row</dt><dd>{payment.sourceRow}</dd></div><div><dt>Transaction time</dt><dd><time dateTime={payment.timestamp}>{payment.timestamp}</time></dd></div><div><dt>Structured reference</dt><dd>{payment.invoiceId?.trim() || "Not supplied"}</dd></div></dl>{payment.memo.trim() && <blockquote>{payment.memo}</blockquote>}<p>{providerVerified ? "Verification applies to this returned sandbox observation, not the invoice or the full account history." : "This observation has not been authenticated through PayPal in this workspace."}</p></details>
        </div>
        {adjustments.length > 0 && <aside className="evidence-map-adjustments"><strong>{adjustments.length} linked {adjustments.length === 1 ? "adjustment" : "adjustments"}</strong><p>Refund or reversal evidence keeps the invoice in review.</p><details><summary>Inspect linked records</summary><ul>{adjustments.map((adjustment) => <li key={adjustment.id}><strong>{adjustment.id}</strong><span>{adjustment.kind} · {adjustment.status.replaceAll("_", " ")}</span><b>{formatMoney(adjustment.grossMinor)}</b></li>)}</ul></details></aside>}
      </div>
      <div className="evidence-map-targets" style={branchStyle}>
        {visible.map((connection) => {
          const { invoice } = connection.row;
          const state = stateOf(connection);
          return <button type="button" key={invoice.id} className="evidence-node evidence-node-invoice" data-state={state} aria-current={invoice.id === invoiceId ? "true" : undefined} aria-pressed={inspected?.row.invoice.id === invoice.id} aria-label={`Inspect evidence for ${invoice.id}`} onClick={() => setInspection({ paymentId: payment.id, selectedId: invoiceId, invoiceId: invoice.id })}>
            <div className="evidence-node-topline"><span className="evidence-node-kind">Invoice</span><span className="evidence-node-state">{stateLabel(state)}</span></div><h4>{invoice.id}</h4><p className="evidence-node-description">{invoice.description?.trim() || invoice.customer}</p>{connection.row.status === "refund" && <span className="evidence-node-warning">Refund exception remains</span>}<div className="evidence-node-bottom"><strong>{formatMoney(invoice.amountMinor)}</strong><span>{invoice.id === invoiceId ? "Current invoice" : "Inspect evidence ↗"}</span></div>
          </button>;
        })}
        {!visible.length && <div className="evidence-map-no-target"><strong>No available destination</strong><p>The loaded records and current decisions do not provide an invoice association for this record.</p></div>}
      </div>
    </div>
    {inspected && <div className="evidence-map-inspector" aria-live="polite"><header><div><span className="evidence-node-kind">Inspected invoice</span><h4>{inspected.row.invoice.id}</h4></div>{inspected.row.invoice.id !== invoiceId && <button type="button" className="text-button" onClick={() => onInvoice(inspected.row.invoice.id)}>Open invoice {inspected.row.invoice.id} →</button>}</header>{inspected.row.invoice.description?.trim() && <p>{inspected.row.invoice.description}</p>}<ul className="evidence-map-facts"><li>{stateLabel(stateOf(inspected))}</li><li>{inspected.row.invoice.amountMinor === payment.grossMinor ? "Amount equals receipt gross" : "Invoice amount differs from receipt gross"}</li><li>{sameKey(payment.customerKey, inspected.row.invoice.customerKey) ? "Customer keys agree" : !payment.customerKey?.trim() || !inspected.row.invoice.customerKey.trim() ? "A customer key is not supplied" : "Customer keys differ"}</li><li>{payment.invoiceId?.trim() === inspected.row.invoice.id.trim() ? "Structured reference agrees" : payment.invoiceId?.trim() ? `Receipt explicitly references ${payment.invoiceId}` : "No structured invoice reference"}</li>{inspected.row.status === "refund" && <li>Invoice-level refund or reversal evidence keeps this case in review.</li>}</ul><details><summary>Invoice source and matching rule</summary><dl><div><dt>Collection</dt><dd>{invoiceSource?.label ?? "Not recorded"}</dd></div><div><dt>Provenance</dt><dd>{provenance(invoiceSource)}</dd></div><div><dt>Source row</dt><dd>{inspected.row.invoice.sourceRow}</dd></div></dl><p>{inspected.candidate?.reason ?? "The receipt has been manually confirmed for this invoice."}</p></details></div>}
    {analysisRelates && analysis && <details className="evidence-map-interpretation"><summary>{historical ? "Inspect pre-decision AI evidence" : proposal?.category === "reference_interpretation" ? `Inspect AI evidence for ${proposal.invoiceId}` : proposal?.category === "ambiguous" ? "AI found ambiguous evidence" : "AI found no supported association"}</summary><p>{historical ? "This interpretation predates the recorded human decision." : "This model interpretation does not allocate a receipt or verify its source."}</p>{proposal?.quote && <blockquote><span>Quoted remittance</span>{proposal.quote}</blockquote>}{proposal?.contextQuote && <blockquote><span>Approved context · {proposal.invoiceId}</span>{proposal.contextQuote}</blockquote>}<p>{analysis.provider === "codex" ? "Codex" : "Gemini"} · {analysis.model}</p></details>}
    {busy && <p className="evidence-map-busy" role="status">Investigating the approved evidence. The source and allocations stay unchanged.</p>}
    <footer className="evidence-map-footer"><p>{visible.length < related.length ? `Showing ${visible.length} of ${related.length} relationships. The full comparison remains searchable.` : "Connections show evidence relationships. Amount and customer agreement alone do not confirm an invoice."}{!selectedIsRelated && ` ${invoiceId} has no current relationship to this record.`}</p>{onCompare ? <button type="button" className="text-button" onClick={onCompare}>{related.length > 1 ? `Compare all ${related.length} invoices` : related.length === 1 ? "Inspect invoice details" : "Inspect full comparison"} ↓</button> : <a href="#candidate-invoices">Full comparison ↓</a>}</footer>
  </section>;
}
