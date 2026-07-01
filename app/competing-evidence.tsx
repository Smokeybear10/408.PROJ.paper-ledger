import type { CandidateAssessment, InvestigationRequest, InvestigationResponse } from "../lib/contracts";
import { proposalEvidenceConflicts, validateProposalEvidence } from "../lib/proposal-evidence";

export type CompetingEvidenceProps = {
  response: InvestigationResponse;
  context: InvestigationRequest;
  historical?: boolean;
  reviewedInvoiceId?: string;
};

function assessmentLabel(stance: CandidateAssessment["stance"], historical: boolean): string {
  if (stance === "supports") return historical ? "Supported this invoice" : "Supports this invoice";
  if (stance === "contradicts") return historical ? "Contradicted this invoice" : "Contradicts this invoice";
  return historical ? "Identifying evidence was missing" : "Missing identifying evidence";
}

function Unavailable({ historical, recorded }: { historical: boolean; recorded: boolean }) {
  return <section className="competing-evidence competing-evidence-unavailable" aria-label="Per-invoice model interpretation unavailable">
    <h3>{historical ? "Earlier invoice comparison" : "Invoice comparison"}</h3>
    <p>{!recorded ? historical ? "This earlier result did not record a per-invoice interpretation." : "This result does not include a per-invoice interpretation." : historical ? "The retained comparison could not be verified against its approved evidence." : "No validated comparison is available for this approved evidence."} Review the original source records.</p>
  </section>;
}

export default function CompetingEvidence({ response, context, historical = false, reviewedInvoiceId }: CompetingEvidenceProps) {
  const assessments = response.proposal.candidateAssessments;
  if (context.invoices.length < 2 && !assessments) return null;
  if (!assessments) return <Unavailable historical={historical} recorded={false} />;
  if (response.requestId !== context.requestId || response.fingerprint !== context.fingerprint || !validateProposalEvidence(response.proposal, context, { requireAssessments: true })) return <Unavailable historical={historical} recorded />;

  const byInvoice = new Map(assessments.map((assessment) => [assessment.invoiceId, assessment]));
  const conflicts = proposalEvidenceConflicts(response.proposal, context);
  const selectedContradicted = Boolean(reviewedInvoiceId && conflicts.contradictedInvoiceIds.includes(reviewedInvoiceId));
  const needsSourceReview = conflicts.structuredReferenceConflict || selectedContradicted;
  const owner = context.payments.find((payment) => payment.id === context.excerptPaymentId);
  const excluded = context.invoiceScope?.excludedCandidates ?? 0;
  const total = context.invoiceScope?.totalCandidates ?? context.invoices.length;

  return <section id="competing-evidence" tabIndex={-1} className={`competing-evidence${historical ? " competing-evidence-historical" : ""}`} aria-label={historical ? "Retained per-invoice model interpretation" : "Per-invoice model interpretation"}>
    <div className="competing-evidence-heading"><div><p className="competing-evidence-kicker">{historical ? "Earlier model interpretation" : "Model interpretation"}</p><h3>{context.invoices.length > 1 ? "Competing invoice evidence" : "Invoice evidence"}</h3></div><span>{response.provider === "codex" ? "Codex" : "Gemini"}</span></div>
    <p className="competing-evidence-intro">{historical ? "These interpretations used the approved text before the recorded decision." : "Compare how the model interpreted the approved text for each invoice."} Approved text may be redacted; compare the quoted spans with the original receipt and invoice records.</p>
    {needsSourceReview && <div className="competing-evidence-hold" role="status">
      <strong>{historical ? "Source conflict in the earlier interpretation" : "Hold this association for source review"}</strong>
      <p>{conflicts.structuredReferenceConflict ? <>The {historical ? "earlier " : ""}note interpretation {historical ? "conflicted" : "conflicts"} with the receipt’s structured invoice reference{owner?.invoiceId ? <> ({owner.invoiceId})</> : null}.</> : <>The model {historical ? "interpreted" : "interprets"} the note as contradicting the selected invoice, {reviewedInvoiceId}.</>} {historical ? "This describes the evidence before the decision." : "Review the contradiction in the original source before deciding."}</p>
    </div>}
    <ol className="competing-evidence-list">
      {context.invoices.map((invoice) => {
        const assessment = byInvoice.get(invoice.id)!;
        return <li className="competing-evidence-item" key={invoice.id}>
          <div className="competing-evidence-item-heading"><h4>{invoice.id}</h4><p className={`competing-evidence-stance competing-evidence-${assessment.stance}`}>{assessmentLabel(assessment.stance, historical)}</p></div>
          <div className="competing-evidence-quotes">
            <figure><figcaption>Exact approved remittance span</figcaption>{assessment.quote ? <blockquote>{assessment.quote}</blockquote> : <p className="competing-evidence-missing">No identifying remittance span was recorded.</p>}</figure>
            <figure><figcaption>Exact approved invoice-context span</figcaption>{assessment.contextQuote !== null ? <blockquote>{assessment.contextQuote}</blockquote> : <p className="competing-evidence-missing">{invoice.context.trim() ? "No invoice-context span was cited." : "No invoice context was shared."}</p>}</figure>
          </div>
          {assessment.stance === "unknown" && <p className="competing-evidence-unknown">{historical ? "Support or contradiction was not established for this invoice." : "Support or contradiction is not established for this invoice."}</p>}
          <details className="competing-evidence-sources"><summary>Approved context and citations</summary>{invoice.context.trim() && <div><p>Approved invoice context · {invoice.id}</p><blockquote>{invoice.context}</blockquote></div>}<ul aria-label={`Cited evidence for ${invoice.id}`}>{assessment.evidenceIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>
        </li>;
      })}
    </ol>
    <p className="competing-evidence-scope">{context.invoices.length} of {total} invoice candidates {historical ? "were included" : "included"}. {excluded > 0 && <>{excluded} {excluded === 1 ? "candidate was" : "candidates were"} outside this investigation and {excluded === 1 ? "was" : "were"} not rejected. </>}{historical ? "The manual decision was recorded separately." : "Human confirmation is required before an association is recorded."}</p>
  </section>;
}
