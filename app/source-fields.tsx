"use client";

import { useMemo, useState } from "react";

type Props = { title: string; fields: Record<string, string> };

const PAGE_SIZE = 20;

export default function SourceFields({ title, fields }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const entries = useMemo(() => Object.entries(fields), [fields]);
  const filtered = useMemo(() => {
    if (!open) return [];
    const term = query.trim().toLowerCase();
    return term ? entries.filter(([name, value]) => name.toLowerCase().includes(term) || value.toLowerCase().includes(term)) : entries;
  }, [entries, open, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function clearSearch() {
    setQuery("");
    setPage(0);
  }

  return <details className="source-fields" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{title} <span>{entries.length} {entries.length === 1 ? "field" : "fields"}</span></summary>
    {open && <>
      <div className="source-fields-search">
        <label>Search field names and values<input type="search" aria-label={`Search ${title}`} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
        {query && <button type="button" aria-label={`Clear ${title} search`} onClick={clearSearch}>Clear search</button>}
      </div>
      <dl className="source-fields-list">
        {visible.map(([name, value]) => <div key={name}><dt>{name}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{value === "" ? "Not supplied" : value}</dd></div>)}
      </dl>
      {!visible.length && <p className="source-fields-empty">{entries.length ? "No fields match this search." : "No source fields supplied."}</p>}
      <div className="source-fields-pagination">
        <span aria-live="polite">{filtered.length} of {entries.length} fields{visible.length > 0 && <> · {currentPage * PAGE_SIZE + 1}–{currentPage * PAGE_SIZE + visible.length} shown</>}</span>
        <div>
          <button type="button" aria-label={`Previous ${title} fields`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button type="button" aria-label={`Next ${title} fields`} disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div>
      </div>
    </>}
  </details>;
}
