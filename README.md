# Paper Ledger | Payment Reconciliation

Match PayPal receipts to invoices, review conflicting evidence, and record the reason for each confirmed allocation.

## Quick Start

Requires Node.js 20.9 or newer and npm. The sample ledger works without credentials or a database.

```bash
git clone https://github.com/Smokeybear10/408.PROJ.paper-ledger.git
cd 408.PROJ.paper-ledger
npm ci
cp .env.example .env.local
npm run build
npm run start
```

Open http://127.0.0.1:3107 and choose **Try the sample ledger**. Keep port 3107: the API accepts local requests on that port. Use `npm run dev` while developing and `npm run typecheck` to check types after a build.

## What It Does

**Review receipts**

- Import invoice and payment CSVs with column mapping and a replacement preview.
- Compare candidate invoices, inspect original fields, and find installment combinations.
- Calculate amounts in integer cents, keeping gross receipts, fees, and net amounts separate.
- Confirm or reject associations with a reason; suggested matches never allocate money automatically.

**Keep a record**

- Export reconciliation CSVs, case evidence briefs, and review reports.
- Save and reopen a JSON workspace containing records and manual decisions.

The active workspace lives in browser memory. Save a workspace before refreshing or closing the tab. Workspace files exclude AI responses; export an evidence brief or report separately to retain that evidence.

## Optional Connections

The **PayPal sandbox** dialog accepts your own sandbox app credentials and reads existing captures or transaction reports. It does not create payments or refunds.

For AI review, configure one provider in `.env.local` and restart. The Gemini adapter reads:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
GEMINI_MODEL=your_available_model_id
```

An authenticated local Codex CLI is also supported. See [provider setup](ARCHITECTURE.md#enable-one-ai-provider) for that configuration and its verification limits. The review dialog shows the selected evidence and provider before sending a request; the reviewer still makes the allocation decision.

## Tech Stack

| Layer | Tools |
|---|---|
| App and API | Next.js, React, TypeScript |
| Validation and CSV import | Zod, Papa Parse |
| Optional connections | PayPal sandbox, Gemini, local Codex CLI |

## Project Structure

```text
app/                    Review workspace and local API routes
lib/reconciliation.ts   Import, matching, and money calculations
lib/receipt-combinations.ts  Installment search
lib/workspace-file.ts   Saved workspace format and validation
public/samples/         Synthetic ledgers and reference cases
ARCHITECTURE.md         Detailed setup, limits, and verification records
```

Built by Thomas Ou
