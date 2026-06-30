import { useState } from "react";
import type { Invoice } from "../lib/contracts";
import { formatMoney } from "../lib/reconciliation";

type Props = {
  invoices: Invoice[];
  caseId: string;
  selectedIds: string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
};

const LIMIT = 20;
const PAGE_SIZE = 12;

export default function InvoiceScope({ invoices, caseId, selectedIds, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const allIds = invoices.map((invoice) => invoice.id);
  const selectionRequired = invoices.length > LIMIT && selectedIds === undefined;
  const included = new Set(selectedIds ?? (selectionRequired ? [caseId] : allIds));
  included.add(caseId);
  const includedCount = invoices.filter((invoice) => included.has(invoice.id)).length;
  const outsideCount = invoices.length - includedCount;
  const term = query.trim().toLowerCase();
  const filtered = invoices.filter((invoice) => `${invoice.id} ${invoice.customer} ${invoice.description ?? ""}`.toLowerCase().includes(term));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const caseVisible = visible.some((invoice) => invoice.id === caseId);

  function toggle(id: string, checked: boolean) {
    const next = new Set(included);
    if (checked) next.add(id);
    else next.delete(id);
    next.add(caseId);
    if (next.size > LIMIT) return;
    onChange(allIds.filter((invoiceId) => next.has(invoiceId)));
  }

  function showCurrent() {
    setQuery("");
    const index = invoices.findIndex((invoice) => invoice.id === caseId);
    setPage(Math.max(0, Math.floor(index / PAGE_SIZE)));
  }

  return <details className={`invoice-scope${selectionRequired ? " scope-selection-required" : ""}`}>
    <summary>Investigation scope <span className="scope-summary-count">{selectionRequired ? "selection required" : `${includedCount} of ${invoices.length} invoices`}</span></summary>
    <p className="scope-description">{selectionRequired ? `${invoices.length} invoices relate to this receipt. Choose up to ${LIMIT} for this investigation, or use only the current invoice.` : `Include up to ${LIMIT} related invoices in the evidence sent for interpretation.`} <strong>{caseId}</strong> stays included.</p>
    <p className="scope-counts" aria-live="polite">{selectionRequired && <span>Preview · </span>}<strong>{includedCount}</strong> included <span>·</span> <strong>{outsideCount}</strong> outside this investigation</p>
    <div className="scope-actions"><button type="button" onClick={() => onChange([caseId])} disabled={!selectionRequired && includedCount === 1 && included.has(caseId)}>Use current invoice only</button>{selectedIds !== undefined && <button type="button" className="text-button" onClick={() => onChange(undefined)}>{invoices.length > LIMIT ? "Reset scope" : "Use all related invoices"}</button>}</div>
    <label className="scope-search">Search related invoices<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Invoice, customer or purpose" /></label>
    <div className="scope-list" aria-label="Related invoices in investigation scope">
      {visible.map((invoice) => {
        const current = invoice.id === caseId;
        const checked = included.has(invoice.id);
        return <label className={`scope-row${current ? " scope-current" : ""}`} key={invoice.id}><input type="checkbox" checked={checked} disabled={current || (!checked && includedCount >= LIMIT)} onChange={(event) => toggle(invoice.id, event.target.checked)} aria-label={`Include ${invoice.id} in investigation`} /><span><strong>{invoice.description?.trim() || invoice.customer}</strong><small>{invoice.id} · {invoice.customer}{current && " · current invoice"}</small></span><b>{formatMoney(invoice.amountMinor)}</b></label>;
      })}
      {!visible.length && <p className="scope-empty">No related invoices match this search. <button type="button" className="text-button" onClick={() => { setQuery(""); setPage(0); }}>Clear search</button></p>}
    </div>
    <div className="scope-pagination"><span>{filtered.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length}` : "0 matches"}{term && ` · ${invoices.length} related`}</span>{pageCount > 1 && <div><button type="button" aria-label="Previous scope invoices" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {pageCount}</span><button type="button" aria-label="Next scope invoices" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div>}</div>
    {!caseVisible && <button type="button" className="text-button" onClick={showCurrent}>Show current invoice {caseId}</button>}
    {includedCount >= LIMIT && <p className="scope-limit">{LIMIT}-invoice limit reached. Uncheck an invoice to include another.</p>}
    <p className="scope-footnote">Excluded invoices are outside this investigation, not rejected matches. Scope selection does not send evidence or approve an allocation.</p>
  </details>;
}
