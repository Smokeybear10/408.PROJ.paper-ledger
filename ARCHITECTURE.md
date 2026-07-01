# Paper Ledger | Architecture and Judge Setup

**Source: [Smokeybear10/408.PROJ.paper-ledger](https://github.com/Smokeybear10/408.PROJ.paper-ledger)**

Paper Ledger helps a bookkeeper reconcile PayPal receipts with invoices, inspect conflicting evidence, and record a reason for each confirmed match.

**Current submission candidate — November 10, 2026:** the local app includes exact installment search, per-invoice AI evidence, and the revised desktop/mobile interface. The matching **2:15.07 narrated demo is complete but not published**. The [earlier public video](https://youtu.be/aVgbXZFPMJ4) is the older 2:07.27 silent demo. Public `main` still contains the earlier application; the new source and video must be published together before using them in the entry.

Judge entry points: [run locally](#judge-quick-start), [try the sample](#try-the-sample-and-review-workflow), [enable AI](#enable-one-ai-provider), [connect PayPal sandbox](#enable-paypal-sandbox-reads), [entry draft](#6-competition-entry-draft).

## Judge quick start

Use **Node.js 20.9 or newer** and npm; the earlier clean-machine rehearsal used Node.js 24.6.0. These are macOS/Linux shell commands. Other operating systems have not been rehearsed.

The current local source archive is `paper-ledger-source-2026-11-10-ready.zip`. To review that candidate before publication, extract it, enter its `paypal-reconciliation` directory, and start at `npm ci`. Cloning public `main` currently gives the earlier release.

```sh
git clone https://github.com/Smokeybear10/408.PROJ.paper-ledger.git paypal-reconciliation
cd paypal-reconciliation
npm ci
cp .env.example .env.local
npm run build
npm run start
```

Open [http://127.0.0.1:3107/](http://127.0.0.1:3107/). Keep port **3107**: the server accepts local browser requests on this port. `npm run dev` is the development alternative. Stop with Ctrl+C. Run `npm run typecheck` after the build has generated Next.js types.

**No credentials are needed for the sample walkthrough.** It exercises import, exact matching, installment search, human review, reports and workspace save/open. Real AI and PayPal reads require the separate setup below; blank credentials never produce simulated provider results. No database or migration is required. Save a workspace file before refreshing or closing the tab.

### Try the sample and review workflow

1. Choose **Try the sample ledger**. The **Review queue** opens seven synthetic invoices and ten payment/event records. Initial totals are **$0 confirmed**, **$4,169.99 unallocated gross**, **$325 pending** and **−$60 adjustments**. These are loaded-record totals, not available cash.
2. Review **Morgan Studio / INV-4107**. PAY701 could cover either of two $500 invoices: **Annual support retainer** or **October implementation balance**. Read the correction in the payment note. Gross ($500), fee ($17.94) and net ($482.06) remain separate. **Linked records** opens the optional evidence map.
3. With an AI provider configured, choose **Analyze payment note → Review data for AI**. Review/redact the excerpt and invoice contexts, approve the named provider, and choose **Investigate with AI**. Inspect the exact quoted spans supporting one invoice and contradicting the other. Without a provider, use the displayed original records for manual review and continue to step 4. No sample AI response is substituted.
4. Review **If you confirm**, then choose **Confirm INV-4107**. Confirmed gross becomes **$500**, unallocated gross becomes **$3,669.99**, and INV-4108 remains unmatched. A proposal never applies itself. The recorded decision retains the original AI scope if a validated investigation was used; undo releases the receipt.
5. Review **Alder Supply / INV-4110**. In **Receipts → Find a payment combination**, choose **Review this combination** for PAY703 ($480), PAY704 ($350) and PAY705 ($450). Inspect their notes, enter a reason, and confirm the $1,280 association. The separate $799.99 inspection receipt remains unallocated. The two confirmed invoices total **$1,780**, leaving **$2,389.99 unallocated gross**. PAY703 plus PAY706 is one cent short and is not an exact combination.
6. Choose **Download evidence brief** for the selected case, **Review report** for all loaded records, or **Export CSV**. Confirmed receipts, decision reasons, separate fees/net and unresolved records remain inspectable. The full report includes retained validated AI from applied decisions; unapplied AI appears only in the selected-case brief.
7. Choose **Workspace → Save workspace**. To reopen it, select the JSON file, inspect the preview, and choose **Restore records and decisions**. Restored sources are unverified imported files. AI responses and approval drafts are excluded, so save evidence/report HTML separately.

For additional cases, inspect INV-4105's $600 partial receipt against $960 due, INV-4106's $325 pending event, and INV-4109's $240 receipt with its linked −$60 refund. Pending events never establish settled coverage; refunds remain visible exceptions. Payment IDs open source records without allocating them.

To exercise import mapping, use `public/samples/invoices.csv` and `public/samples/payments.csv` through **Import files**. Apply each validated replacement explicitly; replacing one collection preserves the other and clears previous review/AI. The separate `public/samples/paypal-activity.csv` is a synthetic English US Activity-header fixture, not an authenticated PayPal download.

### Review installment combinations

Open **INV-4110 / Alder Supply**, then its **Receipts → Find a payment combination** section. PAY703 ($480), PAY704 ($350), and PAY705 ($450) total the $1,280 invoice exactly. PAY703 plus PAY706 is one cent short and is not an exact solution. Select **Review this combination**, inspect the original notes and impact preview, and enter the required decision reason before confirming. The separate $799.99 inspection receipt remains unallocated. Undo releases all three installments.

Search includes eligible unallocated receipts with the same customer key or explicit invoice reference. Owned receipts, rejected associations, conflicting references, pending/unsupported events, linked refunds/reversals, and amounts above the remaining balance are excluded. More than 24 eligible receipts returns an explicit limit instead of silently truncating the pool. Meet-in-the-middle subset sums retain at most 8,192 half-subset states; sum-bucket multiplicities count all solutions without materializing every full combination. One arithmetic solution is not proof of the invoice relationship. Other candidate invoices remain visible, and confirmed partial payments reduce the next search target.

**Download evidence brief** includes current search scope, exact combinations, and unapplied selected receipts. Confirmed allocations and human reasons appear in the case brief, complete report, CSV and saved workspace. Search results are derived from the current records and review; they do not become stored AI evidence or upgrade source verification.

**Original invoice fields** and **Original payment fields** expose the retained source names and exact values; normalized fallback fields are labeled separately. Open the disclosure to search complete names or values, including later fields, in pages of 20 with exact filtered/total counts. Closing it removes field rows from the rendered view. Empty strings show **Not supplied**, while supplied line breaks and spacing are preserved; text is escaped without truncation or a copy action.

For a payment missed by deterministic matching, use **Find another receipt** in the invoice's receipt section. Search the complete eligible unallocated collection by ID, payer, memo or amount, in pages of 12. Selection opens evidence for review and does not allocate it. Receipts explicitly referencing a different invoice are disabled; missing payer IDs are not presented as a customer match. Record the required supporting reason for a manual association before confirming. Multiple distinct completed receipts may cover one invoice, including successive $60 and $40 installments against $100 due; existing confirmations are counted once. Excess confirmed gross remains an overpayment, and one receipt cannot cover two invoices.

All qualifying deterministic candidates remain available across the loaded collections, up to 1,000 invoices and 1,000 payments. **Search candidate invoices** and **Search receipt candidates** search complete candidate lists, rendered in pages of 20. The evidence map shows at most four invoice nodes, with the selected invoice, confirmed owner and supported live interpretation prioritized. Its exact relationship count and **Compare all … invoices** action expose the complete comparison; the four-node view is a presentation bound, not a candidate cutoff. Search/pagination do not change matching or AI scope. **Investigation scope** explicitly selects 1–20 related invoices, always including the current invoice, without rejecting excluded candidates. With more than 20 candidates, a selection is required before inference. The packet, interpretation and exported AI evidence disclose included/excluded counts. The selected receipt and all linked adjustments must still fit the 20-payment bound; no adjustments are silently dropped. A manually selected receipt without a matching rule stays a manual-review case.

The r3 authenticated PayPal path traversed capture lookup, normalization, candidate evidence, manual review and export for one authorized $1.00 sandbox receipt. This goes beyond token authentication or an isolated lookup, while remaining a single controlled functional test of the backend retained in r4.

### Enable one AI provider

The bridge uses this pinned public npm CLI build. The r3 real-HTTP API regression and fresh r4 production-UI sample flow passed with Codex. The provider uses normal operator authentication, without copying credentials into the source package. Install it and sign in on the judge's own machine:

```sh
npm install --global @openai/codex@0.166.0-alpha.5.1
codex --version
codex login
```

Then edit these existing `.env.local` entries and restart Paper Ledger:

```dotenv
AI_PROVIDER=codex
CODEX_BIN=codex
```

The bridge was verified with that CLI version; it uses specific non-interactive capability flags, so a different CLI version must be checked before promising compatibility. If `codex` is not on the Node server's PATH, set CODEX_BIN to its local absolute executable path. Do not copy the developer's path or authentication files. CODEX_MODEL is optional; when unset, the response identifies `codex-cli-default`, not a proven underlying model ID. Use the actual provider/model label from the recorded run in the final submission.

The normal Codex sign-in flow requires an account with model access and available usage. Paper Ledger does not distribute an authenticated account. Installation and sign-in behavior are described in the [official OpenAI Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli).

The portable alternative is the implemented Gemini adapter:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your_local_key
GEMINI_MODEL=gemini-3.5-flash-lite
```

A working key, model access and quota are required. The Gemini network path has not yet been verified against a real account; the default model name is configuration, not a claim of access. Do not publish `.env.local`, API keys or CLI credentials. Configuration badges mean configured, not authenticated or successfully evaluated.

### Enable PayPal sandbox reads

For **Reporting window**, enable **Transaction search** in the app's Sandbox settings and choose **Save Changes** before initial authentication. An existing token/session may not reflect added permissions; fresh authentication does not guarantee immediate PayPal permission propagation.

Open **PayPal sandbox** and enter the **Client ID** and **Secret** for your own sandbox app from PayPal Developer → Apps & Credentials → Sandbox. These are app credentials, never your PayPal email or account password. Choose **Authenticate sandbox app**. No `.env` edit or restart is needed. The inputs clear on submission or dialog close; credentials and tokens are held by the local server process and excluded from workspace files, exports and browser storage.

Optional `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` environment entries initialize the connection once when the process first handles connection status or use. That state is **configured**, not authenticated, until OAuth succeeds. **Disconnect sandbox** clears the active session and disables environment fallback until restart or explicit connection. A failed replacement leaves the previous connection active. This is one local operator's process session, not third-party merchant OAuth or a multi-user credential vault.

Use **PayPal sandbox → Known capture** with an authorized capture ID, or **Reporting window** with explicit UTC dates. The reporting window is at most 31 days and 1,000 records; reporting can lag recent activity. A permission denial is a real connector error. The app never substitutes sample data for an unsuccessful API call.

The app reads existing sandbox transactions; it does not create a checkout or money movement to seed an account. Prepare one authorized completed USD capture outside the app, and one invoice CSV row whose amount and reference reflect the intended demonstration. Keep that invoice's file provenance distinct from the authenticated receipt.

The verified r3 test used a separately authorized temporary QA broker outside Paper Ledger to create one $1.00 sandbox checkout. An existing personal sandbox buyer approved it on PayPal's sandbox site, and one explicit capture completed. Paper Ledger then imported one synthetic invoice CSV, fetched the owned capture through **Known capture**, applied its replacement preview, inspected provenance and recorded a manual reason/confirmation before downloading case/full HTML and CSV. Returned gross was **$1.00**, fee cost **$0.52** and net **$0.48**; confirmed invoice gross became **$1.00**, with **$0.00** unallocated. The invoice stayed an unverified imported file; only the returned receipt was a verified sandbox observation, with one-capture coverage and an inspected provider merchant identity. No AI was run on this receipt because it had no remittance text; the language-investigation checks use separate synthetic cases.

Reporting is a separate permission path. The earlier r3 Nov 1–Nov 6 reporting request returned access denied, and Transaction search was subsequently enabled and saved. After fresh same-app OAuth, the r3 main app successfully read the completed Nov 1–Nov 5 UTC window with HTTP 200. One returned T1900 event was conservatively retained as **other / unsupported**, with unknown fee/net. Those reporting records were not applied; the reviewed capture workspace stayed intact. This establishes authorization for that bounded query, not every event mapping, recent-transaction visibility, immediate permission propagation or complete account history.

Financial calculations and server adapters remain unchanged in r4.1. The intentional r4 restart cleared the memory-only connection; the last reviewed session was disconnected and the Developer login had expired. A new read requires the operator to authenticate their own sandbox app again. Historical authenticated observations do not imply an active connection, and no new r4/r4.1 PayPal read is claimed.

A returned source preview requires **Apply sandbox replacement**. A fresh status check rejects a preview from a disconnected or replaced connection. Applying replaces the entire payment collection and clears previous decisions/AI while retaining invoices. Disconnecting preserves already-applied records as historical observations. Inspect **Sources** for requested range, observed range, filters, actual returned account identity and fetch time. One capture is one observation; a fully fetched query window is not complete account history. OAuth success alone verifies no loaded records and does not establish reporting permissions.

## 1. System overview

A local Next.js application keeps the current invoice/payment dataset and review decisions in browser memory.
The operator can explicitly save a versioned local workspace file and preview a validated restore. No automatic or server-side ledger storage is used.
A pure TypeScript domain module validates money, normalizes rows, proposes candidates and applies reviewed allocations.
Two server routes make bounded read-only PayPal sandbox calls and structured AI investigations through Gemini or a restricted authenticated local Codex CLI.
AI configuration remains in the server environment or the operator's normal CLI credential manager. Sandbox app credentials and tokens live in a private process-memory session, optionally initialized once from the environment. No database, account system or background workers are required.

```mermaid
graph TD
  User[Operator] --> Workspace[Browser workspace]
  Files[Invoice and payment CSVs] --> Domain[Pure reconciliation domain]
  Workspace --> Domain
  Samples[Labeled sample data] --> Domain
  Workspace --> Saved[Local workspace file]
  Saved --> Restore[Validate records and review; downgrade provenance]
  Restore --> Domain
  Domain --> Evidence[Candidates and exact financial observations]
  Evidence --> Review[Manual confirm / reject / undo]
  Review --> Export[Local CSV and complete HTML report]
  Workspace --> PayPalRoute[Server PayPal route]
  PayPalRoute --> Session[Process-memory sandbox connection]
  PayPalRoute --> Sandbox[PayPal sandbox]
  PayPalRoute --> Domain
  Workspace --> AIRoute[Server investigation route]
  AIRoute --> Model[Gemini structured output]
  AIRoute --> Codex[Restricted local Codex CLI]
  Codex --> OpenAI[OpenAI model inference]
  AIRoute --> Evidence
```

Boundaries:
- Files, network responses and model output are untrusted.
- Provider provenance applies only to returned API observations.
- Model proposals and human confirmation do not upgrade provenance.
- Only confirmed allocations affect confirmed gross-coverage totals.

## 2. Components

These are the implemented component locations.

| Component | Purpose | Owns | Depends on | Lives in |
|---|---|---|---|---|
| App shell | Server-rendered entry and initial AI configuration | Initial shell; no secrets in props; PayPal status is queried dynamically | Workspace | app/page.tsx, app/layout.tsx |
| Workspace | Import preview, ledger, selected case and review | Current dataset, revisions, active requests and decisions | Domain and server routes | app/workspace.tsx |
| Product styles | Ledger, evidence and responsive states | Visual presentation | App shell and workspace | app/globals.css |
| Reconciliation domain | Types/schemas, CSV normalization, money, candidates, review and export | Pure financial and state transitions | Zod and CSV parser | lib/reconciliation.ts |
| Shared contracts | Canonical types and boundary schemas | Validated data shapes | Zod | lib/contracts.ts |
| Local server boundary | Enforce loopback Host/Origin, bounded JSON and sanitized errors | Shared request policy for both routes | Native Web APIs | lib/server-boundary.ts |
| Sample ledger | Reproducible, explicitly synthetic cases | Fixture records | Domain types | lib/sample-data.ts |
| PayPal adapter | Connection status/connect/disconnect, OAuth, capture/report reads and normalization | Versioned process-memory session, token cache and connection-bound requests | Fixed PayPal sandbox endpoints; boundary schemas | app/api/paypal/route.ts |
| AI adapter | Recompute evidence, enforce approved provider, validate semantic proposals | Separate required provider envelope, server configuration and model response validation | Gemini or local Codex bridge; API/domain schemas | app/api/investigate/route.ts |
| Codex bridge | Bounded text-only local CLI invocation | Private temporary files, process cancellation, concurrency and output limits | Installed authenticated Codex CLI | lib/codex-inference.ts |
| Investigation desk | Receipt-centered exception grouping and exact decision previews | Derived findings and noncommitting allocation simulation | Validated domain | lib/case-intelligence.ts, app/investigation-desk.tsx |
| Evidence map | Bounded visual trace from a source record to invoice relationships | Up to four inspected nodes, explicit source/AI/human states and access to full comparison | Dataset, reconciliation and validated investigation | app/evidence-map.tsx |
| Candidate comparison | Complete searchable and paginated receipt/invoice relationships | Presentation of gross/reference/customer/eligibility and live selection | Reconciliation result and shared contracts | app/case-comparison.tsx |
| Payment record inspector | Open queue/receipt IDs without allocating or sending evidence | Inspected record ID, explicit TXN-linked source navigation and deliberate invoice-review navigation | Current payment collection and reused candidate comparison | app/workspace.tsx, app/case-comparison.tsx |
| Source fields | Search original invoice/payment fields or labeled normalized fallback | Native disclosure, memoized entries, open-only filtering and 20-field pages | Record fields supplied by the workspace | app/source-fields.tsx |
| Manual receipt picker | Search eligible unallocated receipts beyond deterministic candidates | Pages of 12, foreign-reference guard and explicit review selection | Current invoice, records and reconciliation | app/receipt-picker.tsx |
| Investigation scope | Explicitly select related invoices for bounded AI input | Required current invoice, 20-invoice limit and included/excluded counts | Current receipt relationships | app/invoice-scope.tsx |
| Review overview and impact | Loaded-record progress and exact before/after allocation effect | Coverage, distinct unallocated gross and noncommitting decision preview | Reconciliation and association preview | app/review-impact.tsx, lib/review-impact.ts |
| Evidence exports | Complete review report and selected-case evidence brief | Escaped standalone HTML; current human decisions, source scopes and validated frozen evidence | Domain and shared contracts | lib/evidence-brief.ts |
| Workspace file | Bounded versioned save/restore of records and manual review | Validation, financial/review invariants and unverified restored sources | Shared schemas and reconciliation domain | lib/workspace-file.ts |

Use a small number of cohesive functions/modules; split a large domain module only when its concerns warrant it.
Avoid a second backend, generic agent framework or speculative service classes.

## 3. Request lifecycles

Timing labels below are design targets, not passed performance guarantees. The dense-graph measurements in the verification section describe a single local stress run.

### Import and reconciliation — target: under 1 second for bounded collections

```mermaid
sequenceDiagram
  participant U as Operator
  participant W as Workspace
  participant D as Pure domain
  U->>W: Select CSV and mapping
  W->>D: Validate bytes, headers, rows and money
  D-->>W: Preview or row errors
  U->>W: Apply collection replacement
  W->>W: Increment dataset revision; clear decisions and AI
  W->>D: Build candidates and exact observations
  D-->>W: Ledger and unresolved exceptions
```

Invoice replacement preserves payments; payment replacement preserves invoices.
There is one active payment source. CSV and sandbox imports replace it rather than append.
Invalid/conflicting imports preserve the current dataset.
Source rows and unsupported-event counts remain inspectable. An invoice may carry an optional description of at most 500 characters; it survives CSV import, workspace save/open and CSV/HTML export. It remains imported context, not an authenticated PayPal observation.

Payment import recognizes a conservative English US Activity header set: Date, Time, TimeZone, Type, Status, Currency, Gross, Fee, Net and Transaction ID. It combines supplied US dates and times only with supported US zone abbreviations, UTC/GMT or numeric offsets; it does not invent a missing clock or infer the merchant's locale. A detected-format panel exposes the normalization convention. Activity Fee signs are accepted only when supplied Gross/Fee/Net prove an exact bridge; a nonzero Fee without Net is a correction error. Explicit normalized fee-cost mappings retain their signed-cost convention, and missing components remain unknown.

Memo balance-impact rows, unknown directions and directions incompatible with a known receipt/adjustment remain unsupported records. Unknown events and invoice-only statuses cannot establish settled coverage. Conflicting nonempty invoice-reference columns require explicit mapping. Related transaction IDs preserve their relation type. This supports the documented Activity subset, not every locale or other PayPal report format, and it never authenticates a CSV. [PayPal Activity download fields](https://developer.paypal.com/reports/activity-download/)

### Selection, filtering and review — target: under 100ms locally

```mermaid
sequenceDiagram
  participant U as Operator
  participant W as Workspace
  participant D as Pure domain
  U->>W: Select or filter a result
  W->>D: Read local candidates and observations
  D-->>W: Evidence panel
  U->>W: Inspect payment event or explicit TXN-linked record
  W-->>U: Full source facts; no allocation or evidence sending
  U->>W: Confirm / reject / undo
  W->>D: Validate available receipts and apply decision
  D-->>W: New confirmed allocations and candidate availability
  W->>W: Increment review revision; invalidate old analysis
```

The investigation view starts with compact loaded-record progress and a filtered work queue. The selected invoice puts receipt/candidate comparison beside the human decision; **Interpret payment note** opens **Review AI evidence**, and **Review decision** jumps to the association controls. The side panel keeps a compact scope summary and reopening action rather than duplicate editors. One native dialog, at most 760 px wide, contains the single scope selector, remittance editor and invoice-context editors. Its evidence region scrolls internally while the approval footer stays available. Opening focuses the dialog title; closing restores the enabled opener. Validated dispatch closes the dialog and focuses the pending investigation's **Cancel** action. Closing/reopening the same context preserves redactions and same-provider approval; evidence edits revoke it. Opening never grants consent or triggers inference.

Queue links carry their finding's preferred receipt so another finding for the same invoice cannot silently select the wrong payment. Reopening the same invoice with no change to its preferred receipt context preserves drafts and consent; changing case context clears stale sending drafts/consent. The optional **Relationship trace** distinguishes unconfirmed candidates, validated live AI interpretations, ineligible evidence and confirmed human associations. Inspecting a map node does not navigate or allocate; an explicit action opens another invoice. At most four nodes render, and the complete comparison remains searchable in pages of 20. Navigation rechecks current relationships and eligibility. Before confirmation, exact impact shows confirmed gross, unique eligible unallocated gross, remaining amount and affected competing invoices. The human decision precedes retained AI, which uses past-tense wording and its original evidence counts; technical citations, source fields and calculation detail use disclosures.

Clickable payment IDs in the queue and receipt ledger open a read-only record dialog, including pending, refund and unsupported events. It reuses the candidate comparison for the full note, money bridge, source facts and related invoices. Explicit TXN references link source records in either direction and are paged in groups of 12; an order/subscription ID is not treated as a transaction link. Following a source link only changes the inspected record. Opening a related invoice is a separate deliberate navigation into the normal review flow; neither action confirms a receipt, changes a rejection, sends AI evidence or upgrades provenance.

The workspace memoizes reconciliation for the current dataset/review and passes that result into desk derivation, association preview and review impact instead of repeatedly deriving the same current graph. A proposed decision still computes its own simulated after-state. Queue evidence-ID chips mount only when the finding's details open. `SourceFields` memoizes source entries, filters only while open and renders at most 20 exact name/value rows; changing the record or dataset keys a new disclosure. These are implementation bounds and reuse mechanisms, not a measured latency promise.

One receipt cannot be confirmed for two invoices.
Manual review can associate an eligible unallocated receipt without a customer/reference match, with a required supporting note in the interface; an explicit reference to another invoice cannot be overridden. Selecting a receipt is a draft, not a financial decision. Multiple receipts may be confirmed successively against one invoice; duplicate IDs and existing confirmations are counted once, and excess gross remains overpayment. Pending, unsupported and nonpositive receipts remain ineligible. Linked adjustments and unrelated candidates do not contaminate a different confirmed owner's invoice status.
Suggested coverage and confirmed allocations are different fields.
Fees do not reduce invoice gross coverage.
Refunded or reversed receipts remain explicit exceptions.
Render a bounded page of ledger rows; do not put network requests on this path.

### AI investigation — immediate progress, bounded remote request

```mermaid
sequenceDiagram
  participant U as Operator
  participant W as Workspace
  participant A as Investigation route
  participant G as Selected AI provider
  U->>W: Select invoice scope; preview/redact excerpt and context
  W->>W: Bind approval to provider; capture request ID and fingerprint
  W->>A: Bounded domain case plus approved-provider API envelope
  A->>A: Enforce local request boundary and recompute facts
  A->>A: Reject provider mismatch before dispatch
  A->>G: Bounded structured semantic request; no payment tools
  G-->>A: Completed structured response or named error
  A->>A: Validate IDs, citations and exact note/context quotes
  A-->>W: Semantic proposal and deterministic observation IDs
  W->>W: Recompute current fingerprint and request identity
  alt Current request and case
    W-->>U: Reviewable interpretation with cited evidence
  else Changed data, decision, selection, excerpt or context
    W->>W: Discard stale result
  end
```

The fingerprint covers dataset/review revisions, selected case, scoped invoice and receipt IDs, scope counts, allocations, previewed excerpt and every approved per-invoice context string. Editing scope or sending context invalidates stale results and consent without editing imported data. Context belonging to excluded invoices is removed from sending drafts. Replacing description source data follows normal collection replacement. A sending context is at most 500 characters per invoice; the remittance excerpt is at most 1,200 characters.

Browser consent is bound to the displayed configured provider; an unavailable provider cannot receive advance approval. Every investigation API request requires `expectedProvider` (`codex` or `gemini`) in a separate transport envelope. The route destructures it out of the domain input, compares it with active server configuration and rejects a mismatch with HTTP 409 before provider dispatch. It is not included in the model evidence or financial fingerprint. The browser also checks the returned provider; a mismatch clears approval and no proposal is accepted. Reload/review the destination before approving a changed provider.
A newer request ID invalidates an older request even if its content matches.
Aborting a request is best effort; reducer acceptance checks enforce correctness.
Financial amounts displayed beside a proposal come from deterministic code.
The model proposes an interpreted reference and exact quoted evidence, never an allocation action. If it uses invoice context, `contextQuote` must be an exact nonempty substring of the proposed invoice's approved context and cite `context:<invoice ID>`; unrelated context citations are rejected. Optional imported descriptions are copied only by the operator into editable sending drafts. Empty/unapproved fields are not automatically shared.

The deterministic graph is not capped at the AI bound. The operator may explicitly select 1–20 related invoices, including the current invoice, without altering allocations or rejecting other candidates. If a subset is selected, the packet supplies total/excluded counts, the model is instructed to limit its interpretation, and the UI and exported AI evidence show that limitation. Without a valid explicit scope, more than 20 related invoices blocks inference with the actual count. The selected receipt plus all linked adjustments must fit the 20-payment limit; adjustments are never sliced away. Manual review remains available, and search/page filters never silently change scope.
Gemini requests use store:false. Local Codex uses ephemeral CLI execution with command execution, browser/computer access, connectors, hooks and delegation disabled, and no inherited user configuration. The same quote/ID/arithmetic validation follows both providers. Codex requests are serialized, capped at 60 seconds and 512 KB of output; cancellation waits for the child to close before releasing the slot. No provider-side zero-retention claim is made.
A validated proposal and its approved invoice context can be frozen with the actual subsequent decision timestamp and dataset/review revision. Original scope counts are recovered from the validated recorded input, not recomputed from candidate availability after ownership changes: an investigation of two of 25 invoices keeps two supplied and 23 excluded after confirmation. Frozen evidence appears below the human decision as **Suggested**, **Evidence was ambiguous**, or **No supported association was found**, without a live next-step prompt. The same original subset limitation survives case/full HTML export. It is removed on undo/source replacement and remains separate from current AI analysis. A quoted context is unverified operator input, not accounting approval or provider verification.

### Sandbox import — immediate progress, complete bounded result before replacement

```mermaid
sequenceDiagram
  participant U as Operator
  participant W as Workspace
  participant P as PayPal route
  participant S as PayPal sandbox
  U->>W: Enter own sandbox app credentials
  W->>P: Connect; transient credentials
  P->>P: Enforce local request boundary
  P->>S: Fixed sandbox OAuth endpoint
  S-->>P: Validated token or named error
  P->>P: Atomically install newest successful connection
  P-->>W: Safe status and opaque connection ID
  U->>W: Request capture or bounded reporting window
  W->>P: Typed parameters and connection ID
  P->>P: Bind read and refresh to current connection
  loop Each required reporting page, or one capture lookup
    P->>S: Fixed read-only sandbox endpoint
    S-->>P: Provider response
    P->>P: Validate and normalize; check limits and totals
  end
  P-->>W: Records, provenance, coverage and connection ID
  W->>W: Reject stale dataset or connection response
  W-->>U: Replacement preview
  U->>W: Apply source replacement
  W->>P: Fresh connection-status check
  P-->>W: Current connection ID
  W->>W: Clear decisions and old AI; run same reconciliation domain
```

Capture lookup replaces the active payment collection with that record; it does not append a duplicate.
Reporting uses explicit dates, all pages and balance_affecting_records_only=Y.
Failed, inconsistent or over-limit requests do not replace the current collection.
The reporting adapter recognizes positive incoming USD T0000 General Payment and T0006 Express Checkout records, with only supported completed receipts eligible for allocation; the capture adapter uses its separate CAPTURE mapping. Pending, refund, reversal and unsupported events remain explicit. These mappings have contract checks; actual merchant access is not established by those checks.
A completely fetched query window is not lifetime account coverage.
The same POST route accepts strict status/connect/disconnect operations. Its namespaced versioned store lives in one Node process. Candidate credentials are authenticated before atomic installation; only the newest attempt may install, and failure preserves the prior connection. Replacement/disconnect abort old reads and refreshes. OAuth completion, every report page and final responses recheck connection identity, preventing late token-cache writes and cross-connection results. Successful reads carry an opaque connection ID outside source/account identity; the UI binds previews to that ID and dataset revision, then checks status again before application. Already-applied records remain historical observations after disconnect; restoring a workspace clears the transient connection attribution. No credentials or tokens enter source metadata, saved files or responses.

### Export — local operation

Export confirmed allocations, separately named suggestions, source IDs, fee/null state and coverage.
Escape user-controlled formula prefixes and quote CSV fields correctly.
The header’s complete review report uses `buildReviewReport` to derive all loaded invoice/payment rows, open findings, current human decisions, validated retained pre-decision AI and source coverage. It works independently of the selected case and excludes unapplied investigations. The selected-case brief uses `buildCaseBrief` and can include current validated investigation evidence and a clearly labeled manually selected draft receipt; a draft is never exported as a confirmed allocation. Both escape untrusted text, use a standalone no-script CSP and preserve source timestamps; neither is a durable audit log. The report does not establish account completeness or that an unmatched invoice is unpaid.
No export request reaches a provider or accounting system.

### Save and restore — local files

The Workspace dialog downloads a versioned JSON file containing normalized records, original row fields, manual decisions/notes, revisions and selection. It excludes AI responses, frozen model evidence, credentials and active requests. The separate complete review report or selected-case evidence brief preserves retained model analysis from a reviewed decision.

Opening a workspace validates actual UTF-8 bytes (16 MiB maximum), schemas, calendar dates, exact money, unique provider observations and all manual allocation/rejection rules. A preview shows record/decision counts before explicit replacement. Invalid files preserve the active dataset and draft notes. Restored source labels identify a workspace file; provider verification, fetched-account identity and original query-completeness claims are discarded. Observed ranges are derived again from the restored records. Saved decisions are operator-managed claims, not an authenticated audit log.

Restore preserves validated dataset/review revisions and decision timestamps, invalidates all pending request identities and file reads, synchronously replaces the current snapshot, and clears current/frozen AI. A late response cannot apply even if the restored revisions match an earlier workspace.

## 4. State topology

| State | Logical home | Physical home | Lifetime | Failure mode |
|---|---|---|---|---|
| Invoices and payments | Browser memory | Workspace dataset state | Current tab | Reopen an explicitly saved workspace after refresh |
| Original source evidence | Browser memory | Normalized record provenance | Dataset | Unverified/missing fields remain explicit |
| Dataset revision | Browser memory | Workspace revision counter | Current tab | Old request/result cannot apply |
| Confirmations and rejections | Browser memory | Review state keyed by record IDs | Dataset | Cleared on source replacement |
| Review revision | Browser memory | Review state counter | Dataset | Pending AI invalidated after review/undo |
| Selection/filter/page | Browser memory | Workspace view state | Current tab | Fall back to all results |
| Read-only payment inspector | Browser memory | Inspected payment ID and TXN-link page | Open record dialog | Source replacement removes obsolete records; inspection never allocates |
| Source-field disclosure/search/page | Browser memory | Keyed invoice/payment field viewer | Current record/dataset | Closed rows unmount; search spans all retained fields and stale pages clamp |
| Manual receipt draft and decision reason | Browser memory | Selected receipts and decision editor | Current case | Only explicit confirmation changes coverage; drafts are excluded from restore |
| AI invoice scope | Browser memory | Explicit related-invoice selection | Current case | Scope changes clear consent/results; full matching graph remains |
| Redacted excerpt and approved invoice context | Browser memory | Explicit sending drafts | Current case | Changed context clears consent/current AI; same-context case reopening preserves drafts |
| Approved AI provider | Browser memory | Provider-bound consent plus required API envelope | Approved case/provider | Missing approval blocks dispatch; server/provider mismatch returns 409 before sending |
| Active request and fingerprint | Browser memory | Request context | Pending request | Stale response discarded |
| AI proposal | Browser memory | Current case result | Until case context changes | Keep deterministic evidence |
| Frozen AI/context evidence | Browser memory | Versioned decision evidence | While its exact manual decision remains | Cleared on undo/replacement; excluded from workspace JSON |
| PayPal credentials | Server memory | Private versioned process session; optional one-time environment initialization | Until replacement, disconnect or process exit | Failed replacement keeps prior session; disconnected session cannot fall back to environment |
| PayPal OAuth token | Server memory | Cache bound to the exact connection object | Until expiry or connection retirement | One refresh after 401; stale refresh cannot populate a new session |
| PayPal connection ID | Server/browser memory | Opaque random session identity and replacement preview | Current process connection | Read/apply reject a replaced, disconnected or restarted session; never treated as merchant identity |
| AI provider/model configuration | Server configuration | Environment variables | Process configuration | AI unavailable or named provider error |
| Codex authentication | Local CLI credential manager | Operator-managed CLI session | Account/session lifetime | Sign-in or model access required |
| Sample ledger | Versioned source | lib/sample-data.ts | Build | Import a file instead |
| Review exports | Operator filesystem | Downloaded CSV, complete report or case HTML | Operator-managed | Local snapshot, not an authenticated audit log |
| Saved workspace | Operator filesystem | Explicit JSON download | Operator-managed | Invalid files cannot replace current work; AI and verified-source claims do not restore |

No localStorage, cookie ledger, server database or durable audit-log claim is introduced.
Every monetary field is integer USD minor units, with signed gross/net and signed fee cost.
Validate safe integer bounds at normalization and aggregation.

## 5. Deployment topology

```mermaid
graph LR
  subgraph Browser[Operator browser]
    UI[Workspace and pure domain]
    Memory[Current tab state]
    UI --> Memory
  end
  subgraph Local[Loopback Next.js process]
    Routes[PayPal and investigation routes]
    Env[AI configuration and optional sandbox bootstrap]
    Env --> Routes
    Session[Process-memory sandbox connection]
    Routes --> Session
    CLI[Restricted local Codex CLI]
    Routes --> CLI
  end
  subgraph External[External services]
    PP[PayPal sandbox only]
    GG[Google Gemini]
    OA[OpenAI inference]
  end
  UI --> Routes
  Routes --> PP
  Routes --> GG
  CLI --> OA
  UI --> Download[Local CSV / review report / case brief / workspace]
  SavedFile[Saved workspace] --> UI
```

Local origin: http://127.0.0.1:3107. This fixed loopback origin is also enforced by the server request boundary.
Both development and local production processes bind to loopback.
Credential-backed routes enforce allowlisted Host, exact Origin, JSON content type and actual body limits.
Construct fixed provider paths server-side; reject redirects and caller-supplied endpoints.
Do not return credentials, access tokens, raw provider errors or whole account payloads.
Do not log source memos, customer records or model request contents.
The sandbox session is process-local, shared by this single operator's tabs and lost when that process exits. A versioned global slot preserves the same session across module re-evaluation within a process; it is not a distributed store or a promise of persistence across development restarts. Disconnect retires active references and aborts work, not a guarantee of heap zeroization. Environment configuration is not rewritten or deleted; it cannot silently reactivate a disconnected session.

Initial judge path: reproducible local build plus the permitted demonstration video.
The verified capture path and remaining reporting/judge-access limits are listed in the submission handoff below.
Public hosting is not performed by this plan. Before publication, review authentication, cost limits and judge access.
No production deployment or rollback has occurred.

## 6. Competition entry draft

**Project:** Paper Ledger

**Short description:** Reconcile PayPal receipts with quoted evidence, exact installment matching and human review.

**Description:**

A bookkeeper sees one $500 receipt and two $500 invoices from the same customer. Matching the amount does not explain whether the customer paid an annual support retainer or an October implementation balance. Paper Ledger brings the original records, the customer's correction and the effect of a proposed match into one review workspace.

The operator approves a bounded excerpt and invoice context before a real AI request. The model returns per-invoice assessments with exact supporting or contradicting quotes and citations. The interface keeps those interpretations beside the source evidence. The operator confirms or rejects the association; the model cannot allocate receipts or move money.

Installments use deterministic integer-cent arithmetic. A meet-in-the-middle search finds combinations within an explicit 24-receipt scope and counts all solutions in that scope. In the sample, $480 + $350 + $450 covers a $1,280 invoice; $480 + $799.99 leaves one cent. Selecting a combination changes only the review preview. Confirmation requires a human reason, keeps processing fees separate from invoice coverage, and prevents allocating the same receipt twice.

Paper Ledger reads existing PayPal sandbox capture details or a bounded transaction-search window, and imports invoice/payment CSVs. It preserves provenance, unknown events, partial payments, pending receipts and linked refunds. Standalone HTML and CSV exports connect the source records to confirmed decisions and unresolved exceptions. A local workspace file preserves records and applied human review.

**What the demo proves:** a real Codex interpretation of synthetic payment text, human confirmation of the two-invoice case, exact installment review and exports from the working app. A separately introduced earlier recording shows an actual $1 sandbox capture passing through lookup, review and export. The PDF invoices/receipts illustrate the synthetic CSV records; PDF ingestion is not implemented. No real money is used.

**Current limits:** one local operator, one server process and USD records; no production merchant deployment, accounting certification or measured time savings. PayPal evidence is limited to returned sandbox observations, not complete account history. The current pass does not claim a fresh PayPal read. Model output is validated but can still be wrong; human review is required. The 12-case results below are historical, author-selected synthetic checks, not production accuracy or a comparison with commercial reconciliation systems.

This is a local submission draft. Source/video publication, judge access and final Devpost submission must be verified separately.

### Tools and AI disclosure

| Tool | Actual role | Verification boundary |
|---|---|---|
| PayPal sandbox OAuth, Payments v2 capture details and Transaction Search v1 | Read-only provider observations with bounded source coverage | On r3, own-app OAuth and the actual $1.00 capture → lookup → normalization → manual review → verified-export path passed. Only the returned receipt had sandbox provenance; its invoice remained unverified. A bounded reporting read returned HTTP 200 after permission enablement/fresh OAuth, retaining one unknown event as unsupported without applying it. Financial calculations/server adapters are unchanged in r4.1; the r4 restart cleared the connection and no new read is claimed. Complete history and every mapping remain unverified |
| OpenAI via configured local Codex; public npm CLI 0.166.0-alpha.5.1 | Runtime text interpretation with per-invoice evidence, a closed response schema, exact quotes, supplied citations and provider-bound consent | The latest local recording contains a real Codex call on the current synthetic Morgan case followed by human confirmation. The historical 12-case regression is separate evidence. `codex-cli-default` is the adapter label, not a verified underlying model ID |
| Google Gemini | Configurable alternative runtime provider through the Interactions API | Implemented; real-account/model access not yet verified |
| TypeScript, Next.js 16.4.5, React 19.3.1 | Local browser workspace and server adapters | Versions pinned in package files |
| Zod 4.6.7 and Papa Parse 5.7.0 | Boundary validation and CSV parsing | Financial results come from deterministic code |
| CSS with Tailwind CSS 4.3.4 build tooling | Plain Arial/Helvetica interface and printable reports | UI behavior and financial calculations do not depend on a design service |

The AI receives only the bounded selected-case invoice/receipt facts, anonymous customer groups, source IDs, deterministic observations, approved excerpt and approved per-invoice context. The text is transmitted exactly as previewed; the operator must redact it. Names/email fields and whole source rows are excluded from structured evidence. The model has no payment tools and cannot change allocations or money. The Codex bridge disables tool capabilities; neither provider is described as operating an autonomous payment agent. Model usage/account limits still apply.

### Historical verification and frozen reference challenge

The November 9 local candidate passed its production build and TypeScript checks, desktop/mobile layout review, a real Codex quotation-and-confirmation flow, exact/one-cent-short installment checks and actual evidence download. The 2:15.07 movie passed full decoding, original-audio packet verification and an independent visual review across every cut. These are functional checks on synthetic sample records; no fresh PayPal read was made. The r3/r4/r4.1 results below retain their original scope and are not a fresh evaluation of every current feature.

Verification below separates the r4.1 publication checks and r4 UI/build checks from the r3 model regression, actual sandbox workflow and bounded reporting authorization. Financial calculations and server adapters are unchanged, but the 12-case regression was not rerun on r4/r4.1; the last reviewed r4 session's PayPal connection was cleared. These controlled checks do not establish production merchant use, complete account history, universal event support, representative performance or model production accuracy.

**R4.1 warning visibility:** The association preview already computed the post-allocation refund status for an unreferenced receipt with a linked refund. It now exposes `hasRefundAfter`, which drives the visible impact warning. Six actual domain/React-SSR cases passed: only the affected case changed markup, while five others—including the recorded demo case—were byte-identical. Inputs, money calculations, allocation rules, server adapters and AI packets did not change. Fresh 20 dialog-handler/SSR checks, four focus-effect checks and publication-stage typecheck/build passed. The canonical production browser also verified the $240 linked-refund warning outside closed **Calculation details** before confirmation, while the normal INV-4107 case retained its compact $500/$1,590 preview without a warning. Those browser checks made no allocations or provider/model calls and recorded no JavaScript errors.

**Historical package note:** Prior 27-/29-/32-file snapshots passed their own clean setup and archive checks on macOS, with Node.js 24.6.0/npm 11.5.1 recorded for the baseline. The 29-file public-npm Codex CLI flow passed eight case/CSV checks without copied authentication; the 32-file snapshot passed six blank-provider browser/export checks and ten original-checkout real-AI/report checks. Those snapshot hashes and results remain historical, not verification of the current source or authenticated PayPal access.

| Check | Observed result |
|---|---|
| r4 36-file clean source copy | `npm ci`, typecheck and production build passed. The canonical port-3107 production UI used the public Codex CLI with normal operator authentication. Its intentional restart cleared the process-memory PayPal connection; no new PayPal read occurred |
| r4 focused AI dialog | Twenty external handler/SSR checks and four focus-effect checks passed. Eight browser layout assertions passed for one 760 px dialog, one editor/approval set, internal scrolling, enabled-opener focus restoration, preserved redactions/same-provider approval and edit-triggered revocation. The 390 × 807 phone geometry fit without horizontal overflow; the screenshot adapter cropped its capture, so this is not full phone visual QA |
| r4 real AI and downloaded exports | A fresh canonical production-UI Codex call used the exact approved 79-character note and two contexts, closed the dialog and focused Cancel, then returned literal remittance/context quotes supporting INV-4107. Human confirmation yielded $500 confirmed/$1,590 unallocated, with original two-of-two scope retained historically; no JavaScript errors appeared. All 13 checks on the three actual downloads passed: six invoices/six events/one decision, separate fees/net/pending/refund facts, human reason, retained AI and unverified synthetic provenance. One real model call, no retry and no PayPal call |
| r3 36-file clean source copy | `npm ci`, typecheck and production build passed from the clean r3 rehearsal source. The real-HTTP regression and fresh positive AI browser checks below exercised that production runtime |
| Prior clean-copy blank-provider browser workflow | Eight boundary checks and manual confirmation → complete report → workspace save → refresh → restore passed before r3. No AI calls or JavaScript errors occurred; restored provenance remained unverified imported-file evidence |
| Prior staged public-CLI browser workflow | An earlier 36-file production snapshot used public-npm Codex CLI 0.166.0-alpha.5.1 with normal authentication and no copied auth. Ambiguous synthetic note without an invoice ID + approved context → supported INV-4107 → manual reason/confirmation → case/full HTML/CSV passed 13 export checks. The competing invoice remained at zero; pending/refund/provenance stayed separate. This is not a fresh r3 browser check |
| Historical full-graph measurement | A one-off Node run retained all 1,000 × 1,000 candidate relationships: about 397 ms for reconciliation / 887 ms for desk derivation, with roughly 58 MiB reconciliation / 148 MiB combined memory. These are local measurements, not current performance guarantees or customer time savings |
| Current Activity import | 29 external parser/profile assertions and four mocked reporting-adapter assertions passed on synthetic data. No downloaded merchant Activity export or real PayPal API call was used |
| Current manual associations | 23 domain/save-restore checks and 13 picker render checks passed for synthetic orphan receipts, successive installments, ownership/reference guards and file provenance. Render checks are not browser interactions |
| Current sandbox onboarding | 38 mocked handler lifecycle checks passed, including failed replacement, concurrent attempts, disconnect during OAuth/reporting and late refresh rejection; 18 frontend handler checks passed using simulated hook state and mocked local responses. These checks establish no real sandbox authentication or DOM/browser behavior |
| r3 actual sandbox authentication and reporting | Own-app OAuth succeeded. A Nov 1–Nov 6 reporting request initially returned sanitized access denied without replacing current records. After Transaction search was enabled/saved and same-app OAuth refreshed, the main route returned HTTP 200 for Nov 1–Nov 5 UTC with bounded-window provenance and one provider observation. Its T1900 event remained other/unsupported with unknown fee/net. Reporting was not applied; the reviewed capture remained covered. This verifies that authorized query, not recent visibility, all mappings or complete history |
| r3 actual $1.00 sandbox capture workflow | Eight browser assertions passed. A separately authorized external QA checkout was approved by an existing sandbox buyer and explicitly captured once. The r3 app imported one synthetic invoice, fetched the owned completed capture, applied replacement, inspected unverified-invoice/verified-single-receipt provenance, recorded a manual reason/confirmation and downloaded case/full HTML and CSV. Gross $1.00, fee $0.52 and net $0.48 stayed distinct; confirmed gross was $1.00 and unallocated gross $0.00. No AI ran for the receipt's empty remittance, and no console errors appeared |
| r3 actual sandbox downloaded exports | Fifteen independent byte-level assertions passed on the actual CSV, selected-case HTML and complete-report HTML. They preserved one invoice/one returned receipt/one manual confirmation, $1.00 confirmed, $0.52 fee, $0.48 net, $0.00 unallocated, one of one invoices covered, exact human reason and dataset/review revisions. The invoice remained unverified file evidence; only the returned receipt had sandbox provenance, observed merchant identity and single-capture coverage. Both HTML exports retained those source/review facts without AI analysis or production/full-account claims. Private identifiers and actual data files are excluded from public documentation and samples |
| Current original-source field viewer | 21 real-SSR/actual-handler checks passed for closed value absence, memoization/open-only filtering, 20-row pages, late-field search, exact multiline text, escaping, no truncation, clear/reopen and page clamps. Handler state was simulated; no DOM/browser or provider access was used |
| Prior scoped real Codex browser flow | On a synthetic 25-invoice graph, the operator supplied two invoices and disclosed 23 outside scope. The interpretation and case/full exports preserved that limitation; consent/stale cancellation checks passed. This does not certify r3's newer provider envelope or every candidate |
| Dense browser functional check | The r1 live-production browser restored 1,000 invoices and 1,000 receipts with 1,000,000 candidate links, found a late invoice, confirmed one receipt, then excluded it from a competing invoice and already-allocated search. No browser errors were recorded. Some automation input dispatches exceeded three seconds before the page completed; this establishes functionality, not a latency guarantee or a fresh r4 dense-browser run |
| r3 immutable model regression | Actual HTTP POSTs through the r3 domain builder/API returned 12/12 valid Codex results: seven supported associations and five abstentions; zero wrong associations, API/response errors or retries. All seven recorded source hashes matched that r3 snapshot. Financial calculations/API adapters remain unchanged in r4.1, but UI/preview metadata changed and the suite was not rerun. This is one curated synthetic pass, not production accuracy |
| r3 positive AI browser workflow | Eight checks passed: same-context selection retained named-provider approval; real Codex used the literal note/context to support INV-4107; human confirmation preceded past-tense retained AI; original two-of-two scope survived current one-of-one availability; totals were $500 confirmed/$1,590 unallocated/$325 pending/−$60 refunds; decision cleared approval and disabled sending; no console errors. The sample was synthetic and no PayPal request occurred |
| r3 downloaded exports | Thirteen byte-level checks passed on the actual downloaded CSV, selected-case HTML and complete-report HTML: six invoices/six source records/one human decision, $500 confirmed only for INV-4107, $1,590 eligible unallocated, separate fee/net/pending/refund amounts, unverified sample provenance, human reason/versions, literal retained quote and both contexts, historical alternative, and no current AI promoted from the past. Full two-invoice packets correctly omit subset metadata/prose; no machine paths or recognizable credential fields/tokens appeared |

The r3 HTTP regression completed at 2026-11-06 16:36:56 UTC. Its external report is `reference-challenges-live-2026-11-06T16-35-35-629Z-1aa404fc.json`, SHA-256 `f3015d243cc8cda9ffb1244bb921f1bc4a42107a9152f9253ea6ec211b868552`, separate from the unchanged public historical JSON. Recorded hashes for the contracts, domain, investigation route, Codex bridge, local server boundary, workspace and page matched the evaluated r3 snapshot. R4 changed workspace/styles; r4.1 adds impact-preview metadata and warning markup while retaining financial calculations, server adapters and AI packets. The only request adaptation was required `expectedProvider: "codex"` in the API envelope; it was excluded from model input and the financial fingerprint. The immutable cases, labels and scoring method were retained, with zero retries. Expected answers, rationales, case labels and baseline were excluded from generation. Seven supported associations, two ambiguous abstentions and three no-supported-match abstentions matched the predeclared expectations.

The r4 dialog reports are `targeted-checks-2026-11-06.json` (20 handler/SSR assertions), `focus-checks-2026-11-06.json` (four focus-effect assertions) and `r4-browser-layout-checks.json` (eight browser assertions, with the phone-capture limit above). The fresh r4 recording's three synthetic downloads passed 13 checks in `r4-recorded-export-checks.json`, SHA-256 `6dc72481d3bb9c4dba28716c1fd130f5a611da9b13bc2519269da9f38da134ce`. This real model/browser flow is separate from the 12-case regression executed on r3; no new PayPal read occurred.

The earlier r3 browser result is recorded externally in `r3-production-browser-checks.json`, with screenshot `r3-production-reviewed.png`. It verifies r3 provider approval and past-decision presentation; the model label remains `codex-cli-default`, with no verified underlying model ID. Separate read-only validation of the three downloaded synthetic files passed 13 checks in `r3-browser-export-checks.json`, with no new model or provider calls. These remain synthetic sample evidence from r3.

The r3 actual single-capture sandbox run is recorded separately in private external reports: `real-sandbox-browser-checks.json` contains eight passing browser assertions, and `real-sandbox-export-checks-2026-11-06.json` contains 15 passing byte-level assertions on the three downloaded exports. The byte audit made no provider/model calls and left the downloads unchanged. This is a controlled sandbox functional check against one synthetic invoice, not evidence of production accuracy or complete account history. The separate `real-sandbox-reporting-after-refresh.json` records the later successful bounded r3 query, conservative unknown-event handling and then-unchanged reviewed workspace. Those are historical observations of the financial calculations/server adapters retained in r4.1, not claims of an active connection. Private record/account identifiers and raw evidence remain outside public source and samples.

The frozen fixture is `public/samples/reference-challenges.json`; sanitized historical inputs, responses, quotes and scoring are in `public/samples/reference-challenge-results.json`. These assets remain unchanged historical evidence. Their recorded hashes identify the contracts, domain builder, investigation route and Codex bridge from the earlier evaluated snapshot. The r3 regression is separate evidence; the old public result file must not be relabeled as that run. Asset SHA-256 values for the preserved fixture/results are:

```text
reference-challenges.json
  a8e8f11e046f5ec901cd390025ce9336532d143ffeb9adc0fed47120bf68bcb7
reference-challenge-results.json
  d22562bc80cd03a70dd40daa8c7d7a64361a828e98a8dffc5d4d32cce3fb6bf7
```

The preserved historical Codex run completed at 2026-11-06 00:05 UTC (November 5 evening Eastern). It attempted all 12 author-selected synthetic cases: seven supported associations and five abstentions (two ambiguous, three no-supported-match). Expected answers/rationales and the comparison baseline were not sent to generation. The public fixture/results remain unchanged; the later r3 regression is recorded separately above.

| Historical outcome on these 12 cases | Historical Codex run | Simple baseline |
|---|---|---|
| Expected association or abstention | 12 / 12 | 5 / 12 |
| Expected model category | 12 / 12 | Not assigned |
| Wrong associations | 0 | 3 |
| Missed supported associations | 0 | 4 |
| API/response errors | 0 | Not applicable |

The baseline checks a literal invoice ID, otherwise a unique gross-amount/customer-group match; it does not interpret descriptions, negation, corrections or model-control instructions. It is a simple comparator, not a tuned incumbent. Both the historical challenge and later r3 regression use the same curated synthetic cases, not a held-out production evaluation: no real merchants, representative dataset, production accuracy, saved labor, or superiority to established reconciliation systems is established. `codex-cli-default` identifies the adapter setting, not the underlying model. All successful interpretations still require manual review; exact-quote/citation checks do not make operator-provided context true.

### Current local demo — publication pending

`paper-ledger-demo-clean-interface-2026-11-09.mp4` is **135.066667 seconds (2:15.07)**, 1080p/30 fps H.264 with Thomas's original voice. It uses actual browser recordings, clearly fictional sample documents, and an explicitly introduced earlier sandbox recording. There are no subtitles or chapter graphics. Full decode and frame-count checks passed; all 6,331 AAC audio packets match the approved voice source. The file SHA-256 is `bce8ff55af7b2b0f9d6988615d962bdf85d7f49392405d46c61289bb0c0da5ce`.

This revised movie is local only. It needs its own publicly visible YouTube URL before submission; the older URL below does not show this cut.

| Time (seconds) | Current demo content |
|---|---|
| 0–33.900 | Synthetic invoice/receipt documents and the revised working interface; the payment note distinguishes two equal-amount invoices. |
| 33.900–58.333 | Approved real AI request, exact supporting/contradicting quotes, human confirmation and the other invoice remaining unmatched. |
| 58.333–101.833 | $1,280 installment case, three receipt documents, an unapplied one-cent-short alternative, human reason/confirmation and actual download. |
| 101.833–112.533 | Exported source payments, separate fees/net and three human decision rows. |
| 112.533–124.600 | Earlier actual $1 PayPal sandbox capture, review and export; narration identifies it as an earlier recording. |
| 124.600–135.067 | Current ledger: two invoices covered, $1,780 confirmed gross and $2,389.99 unallocated gross. |

Proposed description for the revised upload:

```text
Paper Ledger reconciles PayPal receipts against invoices with quoted evidence, exact installment matching and human review.

The demo follows two synthetic cases in the working app: one receipt that could cover either of two invoices, and three installments covering a $1,280 invoice. A real Codex response cites supporting and contradicting text; the operator confirms the decisions and exports the evidence. PDF documents illustrate the synthetic CSV records; the app does not ingest PDFs.

A separately introduced earlier recording shows a real $1 PayPal Sandbox capture passing through lookup, review and export. No real money is used. No new sandbox read is implied by the revised interface footage.

Source and setup: https://github.com/Smokeybear10/408.PROJ.paper-ledger/blob/main/ARCHITECTURE.md#judge-quick-start
```

### Historical public demo and publication metadata

The [earlier public YouTube demo](https://youtu.be/aVgbXZFPMJ4) uses the historical **127.266667-second (2:07.27)** MP4, 1080p/30 fps H.264 with silent English captions. It uses 347 unchanged source JPEGs from five selected windows; ordinary hard cuts remove offscreen typing/navigation. The original four captures totaling 144.040 seconds remain preserved. Independent edit-manifest, full blank/decode and targeted eight-keyframe checks passed. The full 18.052-second model wait remains visible; it is one recorded wait, not a production latency benchmark. The 15-cue English caption track is saved, and YouTube copyright checks reported no issues.

The actual footage combines the r3 sandbox capture sequence with the r4 synthetic-sample Codex investigation; financial calculations and server adapters are unchanged. Source versions and synthetic labels remain explicit. The final cut shows the following sequence; it does not show typing the decision note, opening downloaded HTML, partial-case review or map exploration. The r4.1 correction does not change the recorded demo case.

| Time (seconds) | Visible content |
|---|---|
| 0–43.127 | Actual r3 $1.00 PayPal sandbox capture fetch, manual review and export. Only the returned receipt has sandbox provenance; the invoice remains synthetic file evidence. |
| 43.127–69.449 | Labeled r4 fictional case: compare two equal-amount invoices for the same customer, distinguishing the November retainer from the October balance. |
| 69.449–105.949 | Focused evidence dialog, named-provider consent, actual Codex request/wait and literal quoted evidence supporting the proposal. |
| 105.949–110.949 | Visible human **Confirm** transition at 108.063 seconds. |
| 110.949–127.266 | Completed review: $500 confirmed/$1,590 unallocated, saved human reason and three actual download events. |

The following metadata accompanies the published YouTube demo. The source/setup link points to this repository's judge instructions.

**Title:** `Paper Ledger | PayPal AI Hackathon Demo`

**Description:**

```text
Paper Ledger reconciles PayPal receipts against invoices with quoted evidence and human confirmation.

The demo shows an actual $1.00 PayPal Sandbox capture passing through matching, manual review and export, followed by a labeled synthetic case using a real OpenAI Codex call to distinguish two equal-amount invoices.

Gross, fees and net remain separate. AI proposes a reference interpretation; the operator confirms the association. No real money is used.

Source and setup: https://github.com/Smokeybear10/paper-ledger/blob/main/ARCHITECTURE.md#judge-quick-start

Sandbox footage uses r3; the synthetic AI flow uses r4. The PayPal and financial backend is unchanged.
```

### Remaining submission artifacts and access

The [official overview](https://paypalaihackathon.devpost.com/) requires a working build, public open-source code with a license, a tools/AI explanation and a publicly visible YouTube video under three minutes. Clear repository setup instructions can satisfy demo access without public hosting. The submission deadline is November 12, 2026 at noon Pacific / 3pm Eastern. [Official rules](https://paypalaihackathon.devpost.com/rules)

| Deliverable | Current evidence / required completion |
|---|---|
| Earlier published build verification | The 36-file r4 clean copy passed install/typecheck/build, 20 dialog handler/SSR checks, four focus-effect checks, eight browser layout checks and a fresh real Codex sample flow with 13 downloaded-export checks. The r4.1 publication stage passed six refund-preview cases, fresh 24 dialog/focus checks and typecheck/build. The 12-case API regression ran on r3; financial calculations/server adapters are unchanged |
| Meaningful authenticated PayPal use | Verified on r3 at the controlled functional-test level: one actual $1.00 sandbox capture was fetched, normalized, reviewed, confirmed and exported to byte-checked downloads. A bounded reporting query succeeded after permission enablement/fresh OAuth; its unknown event stayed unsupported and was not applied. The r4 restart cleared its connection; no new PayPal read is claimed. Complete history, all mappings and production merchant use are not established |
| Earlier runtime AI verification | The r3 HTTP/Codex regression passed 12 immutable cases with zero wrong associations/errors/retries. A fresh r4 canonical-UI real Codex call used named approval, the literal 79-character note and two contexts, followed by human confirmation and original-scope retention. These are synthetic functional checks, not production accuracy |
| Public source; candidate update pending | [Smokeybear10/408.PROJ.paper-ledger](https://github.com/Smokeybear10/408.PROJ.paper-ledger) · MIT. On November 10, public `main` was `d4feec1fede9a6e4b2af219f0a93ae3ab6538333`, with tree `d3a1bdaf97c56f3b0cb2f6cd01f1ac3fa4133eda`, identical in content to local committed baseline `93b6abe`. Current uncommitted source changes are not in that public tree |
| Revised demo; upload pending | The current 135.066667-second (2:15.07) narrated movie is complete and verified locally. The [older public movie](https://youtu.be/aVgbXZFPMJ4) remains a different 127.266667-second silent cut. Publish the revised movie and update the entry URL |
| Entry text and tools disclosure | Drafted above; reconcile statements with the final recorded build before entering the form |
| Judge access through December 15 | Final instructions must make the app and required provider access usable through the end of judging; no developer credentials are bundled in source |
| Registration | Previously confirmed by Devpost; recheck the signed-in entry before final submission |
| Devpost project entry | Last recorded status: not created. The description above is a local draft; the current live form has not been verified |
| Final submission | Not confirmed; complete the entry with public source/video links and verify the final form receipt |

The source license is already MIT in `LICENSE`. The actual sandbox capture path establishes functional PayPal use separately from the synthetic demo; neither source availability nor this test establishes production adoption or final submission.

### Public source package

The current candidate archive is `paper-ledger-source-2026-11-10-ready.zip`, with root `paypal-reconciliation/`. Its external release manifest must identify the exact included files and verification results. Preparing this local archive does not publish the GitHub update.

The prior 36-file r4.1 source package includes the focused AI-evidence dialog, manual receipt picker, explicit invoice scope, source-field viewer, provider-bound consent, synthetic Activity CSV fixture and refund-warning visibility correction. The r4 clean install/build, real Codex UI flow and 13 downloaded-export checks passed; r4.1 passed the targeted cases and publication-stage typecheck/build above. The 12-case regression and actual PayPal checks remain r3 evidence for unchanged financial calculations/server adapters. Archive hashes and extraction verification are recorded in the external release manifest for the matching source snapshot. Archive root is `paypal-reconciliation/`.

```text
paypal-reconciliation/
  app/                       # all application .ts/.tsx/.css files
  lib/                       # domain, impact calculation, contracts and local-file modules
  public/samples/
    invoices.csv             # synthetic fixture
    payments.csv             # synthetic fixture
    paypal-activity.csv      # synthetic English US Activity-header fixture
    reference-challenges.json # frozen authored synthetic cases
    reference-challenge-results.json # sanitized actual single-run results
  .env.example               # blank credentials only
  .gitignore
  ARCHITECTURE.md             # judge setup, contracts and entry draft
  LICENSE
  next-env.d.ts
  package.json
  package-lock.json
  postcss.config.mjs
  tsconfig.json
```

Exclude `.env.local`, every other populated `.env*`, `.next/`, `node_modules/`, `*.tsbuildinfo`, `.git/`, `.gstack/`, OS files, CLI authentication/configuration, saved user workspaces, downloaded evidence/CSV files, recordings and agent review artifacts. Exclude `AGENTS.md`, `DESIGN.md`, `public/design/` and the generated `public/architecture/` snapshot: they are local planning material, not runtime dependencies. This document preserves the current implementation contracts without those duplicate artifacts. Never copy an absolute executable path from the developer machine into `.env.example` or public instructions.

Archive hashes and extraction verification are recorded in the external release manifest for the matching source snapshot; an earlier archive does not verify r4.1. No archive's own hash is embedded in its included Markdown. Record its published commit externally when releasing. Preserve frozen historical assets unchanged and keep the external r3 regression distinct from r4/r4.1 checks. Synthetic fixtures and results retain their limitations; private raw reports and machine paths remain excluded. Link directly to this file's judge setup section from the submission. The revised video must distinguish its earlier sandbox segment from current sample footage rather than imply a new PayPal read occurred.

Current source packaging must also include `app/receipt-combinations.tsx`, `lib/receipt-combinations.ts`, `app/competing-evidence.tsx`, `lib/proposal-evidence.ts`, `lib/reference-scenarios.ts`, `app/challenge/`, and `app/workbench.css`. The current release manifest, not the historical file count, defines the candidate being reviewed.

## 7. Decision log

Initial contracts were selected November 4, 2026; local workspace/provider refinements followed November 5. The November 6 work adds the evidence map, impact/report views, conservative Activity import, manual installments, explicit invoice scope, local process-memory sandbox onboarding and the r4 focused evidence-review dialog.

- **One local Next.js application** — matches Thomas’s stack and supplies built-in server route handlers; separate FastAPI service adds no required capability.
- **Browser-memory financial workspace** — keeps active ledgers off the server. The November 5 local refinement adds explicit user-managed save/reopen files, preserving manual review while downgrading restored provider provenance.
- **One payment source at a time** — explicit replacement prevents CSV/reporting/capture double counting without a merge-resolution product.
- **Exact bounded integer money** — prevents floating-point settlement errors; no FX conversion or arbitrary-precision feature is needed within enforced limits.
- **Gross coverage, separate fees** — a fully paid invoice is not short because the merchant paid a processing fee.
- **Confirmed versus suggested allocations** — only explicit user decisions affect confirmed totals.
- **Conservative event eligibility** — only recognized incoming completed receipt mappings are eligible; imported sources remain unverified and unknown events stay visible.
- **Explicit format conventions** — detected Activity headers expose date/fee normalization; file authenticity and unknown components are never inferred.
- **Manual association authority** — an operator can review an orphan receipt and successive installments with a supporting reason, while ownership and conflicting-reference guards remain deterministic.
- **Evidence beside the decision** — candidate comparison and exact impact stay close to human review; the map and model preparation are optional disclosures, with explicit sending consent.
- **One focused evidence editor** — scope and redacted text live in one bounded native dialog with internal scrolling and an approval footer; close/reopen preserves same-context edits/approval, edits revoke consent, and validated dispatch returns focus to Cancel.
- **Read-only source navigation** — queue and receipt IDs expose full event facts and TXN-linked records without allocations; entering invoice review is a separate deliberate action.
- **Complete fields, bounded rendering** — exact original values remain searchable, while closed disclosures and 20-field pages avoid mounting every value at once.
- **Reuse current reconciliation** — desk, decision preview and impact receive the memoized current result; simulated decisions still calculate their after-state and never mutate current coverage.
- **Bounded visual map, complete candidates** — four visible invoice nodes keep the trace readable; the full relationship set remains searchable and paginated.
- **Measured ledger effect, no invented impact** — decision impact derives before/after gross from current eligible records, not claimed recovered revenue or labor savings.
- **Complete portable report** — all loaded invoices/events, open findings, human decisions and retained validated AI export together; this remains a local snapshot, not a durable audit log.
- **Closed semantic AI response** — reference interpretation and quoted evidence add language understanding; deterministic code owns financial claims.
- **Explicit bounded invoice scope** — the operator selects a disclosed subset when needed; excluded candidates remain available and unreviewed.
- **Original scope survives review** — retained AI reads its recorded counts after ownership changes and appears below the human decision in past tense, without a live next action.
- **Provider-bound consent** — browser approval names the destination; the API requires a separate expected-provider envelope and rejects configuration mismatch before dispatch.
- **Same-context case reopening** — selecting the current invoice with unchanged preferred receipt context preserves drafts and consent; a changed context invalidates them.
- **Request identity and case fingerprint** — cancellation alone cannot prevent a late result from using obsolete allocations.
- **Fixed sandbox/provider endpoints** — browser parameters cannot turn the server into a general authenticated proxy.
- **Process-memory sandbox onboarding** — the operator's app credentials authenticate without environment editing; connection identity prevents stale refreshes and previews from crossing sessions.
- **Native provider fetch** — avoids a model SDK or agent framework where the two request adapters suffice.
- **Verification without a new test suite** — user instruction forbids adding tests absent a request or existing suite; use one-off assertions and browser/integration evidence.
- **No hosting before verification** — a local request boundary is not production authorization.

## 8. Out of scope

- Live payments, refunds, payouts and invoice emails: the entry reads and reconciles sandbox evidence.
- Third-party merchant onboarding: partner access is not established.
- Multi-tenant accounts and durable ledgers: not needed for the approved current-tab workflow.
- FX and non-USD settlement: conversion would add independent accounting semantics.
- Splitting one receipt among invoices: prevents ambiguous allocation complexity.
- Mixed-source merging: explicit source replacement is the approved simpler boundary.
- Model-initiated allocation or payment actions: human review owns decisions.
- Whole-ledger AI upload or general chat: only bounded selected-case evidence belongs in investigation.
- New automated test-suite scaffolding: not requested; appropriate verification remains required.
- Public hosting and production-account integration: the judging path is a local build. Source publication, video and final submission are release deliverables tracked above.

Historical release status: R4.1 source is published in code commit [630b1556](https://github.com/Smokeybear10/paper-ledger/commit/630b1556ba91dba6f6ff1152061bf16cfdce320d). Its warning-visibility correction passed six domain/SSR cases, fresh 24 dialog/focus checks and publication-stage typecheck/build. The r4 clean build, eight browser layout checks and real Codex sample flow with 13 export checks remain recorded above. The 12-case API regression, actual $1.00 sandbox path (eight browser/15 export checks) and HTTP-200 bounded reporting read ran on r3; financial calculations and server adapters are unchanged. The last reviewed r4 session was disconnected after restart; no new PayPal read is claimed. Phone visual QA, every event mapping, recent visibility and complete history remain unverified. Archive evidence belongs to its matching external manifest. The [public demo](https://youtu.be/aVgbXZFPMJ4) is 127.266667 seconds (2:07.27), with passed edit-manifest/blank/decode/eight-keyframe checks and a saved 15-cue English caption track. Devpost registration is confirmed; its project entry is not created and final submission is not complete. Gemini access remains unverified.


Current submission status (November 10, 2026): the redesigned app and 2:15.07 narrated demo are local candidates. Publish matching source/video versions and verify the Devpost project entry and final receipt. Do not treat the earlier public assets or historical checks as proof that the revised submission is complete.
