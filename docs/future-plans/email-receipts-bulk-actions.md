# Email receipts: every action on a selection, and narrowing a selection

Status: approved by the owner in the session that added it (2026-10-16).

## Why

The selection bar on the receipts list (`ReceiptBulkBar`, `POST /email-receipts/bulk`) deletes and ignores many emails, and drafts a profile from up to five. The row menu has more actions: Reprocess, Approve the proposal, and Reprocess on an ignored email (which restores it). A person who selected 351 emails cannot run those on them, and cannot drop part of a selection by state, sender or date.

## Assumptions

- `EmailReceiptPipelineService.process` reads an `ignored` email again (only `skipped` and an applied request are refused, `refuseUnprocessable`); "restore ignored" is therefore reprocessing the ignored emails of the selection.
- Approving a proposal is `POST /ai-review-requests/approve-batch` (`AI_REVIEW_APPROVE_BATCH_MAX` = 100 per call), the same door the row action and the review inbox use. A trade email is never approved from the list (its card in the review inbox shows the account, ticker and total), so bulk approval leaves trades out and says how many.
- The list's filter is a state and a sender domain (`receiptDomainClause`, `src/email-receipts/receipts/receipt-filter.ts`). "Select all matching" sends that filter instead of ids.

## The selection filter (backend, written once)

`ReceiptSelectionFilter` extends the bulk filter. Every field is optional:

| Field | Meaning |
|---|---|
| `status` | the list's state filter (as today) |
| `domain` | the list's sender filter (as today) |
| `excludeStatuses` | states taken out of the selection (max 13, each a `EMAIL_RECEIPT_STATUSES` member) |
| `excludeDomains` | sender domains taken out (each with its sub-domains, the same predicate as `domain`), max 50 |
| `receivedFrom`, `receivedTo` | `YYYY-MM-DD`, inclusive, on `received_at` in UTC; outside the range is out of the selection |

One SQL builder in `receipt-filter.ts` (`receiptSelectionClause`) renders it with bind parameters; the bulk command, the new count, reprocess and approval listing all call it, so the number shown is the number acted on.

## API

- `POST /email-receipts/bulk` (existing, delete and ignore): `filter` accepts the new fields.
- `POST /email-receipts/bulk/count` `{ filter }` -> `{ count }`: how many emails a narrowed filter selects (capped at `EMAIL_RECEIPTS_BULK_MAX_MATCHES + 1`).
- `POST /email-receipts/bulk/reprocess` `{ ids | filter, onlyStatuses?, since?, limit? }` -> `{ processed, failed, byOutcome, remaining, since }`. Runs the pipeline over at most `limit` (1-25, default 10) eligible emails per call, oldest first, each one once per run (`updated_at < since`, the `processBatch` pattern), so the client calls it until `remaining` is 0 and shows progress. Eligible: not `skipped`, not `pending`, no applied request. `onlyStatuses: ["ignored"]` is "restore ignored". Ids: at most `EMAIL_RECEIPTS_BULK_MAX_IDS`. Nothing to confirm by count: reprocessing is what the row action does, and it can be run again.
- `POST /email-receipts/bulk/approvable` `{ ids | filter }` -> `{ requestIds, trades }`: the `aiReviewRequestId` of every selected non-trade email in `review` with a proposed request (at most 2,000; more is a 400 asking to narrow), and how many trade emails were left out. The client confirms "Approve N proposals" and sends `requestIds` to `approve-batch` in chunks of 100, then reports approved and failed.

Every refusal (too many ids, too many matches, a malformed filter) happens before the first write.

## Frontend

- `ReceiptBulkBar` gains: Reprocess (N), Restore ignored (shown when the selection can hold ignored emails), Approve proposals, and a "Deselect by" menu: by state, by sender domain, by received date (before / after a day).
- Ticked rows: deselecting filters the ticked ids by the rows' own `status`, `fromDomain` and `receivedAt`.
- "All matching": deselecting adds to the filter (`excludeStatuses`, `excludeDomains`, `receivedFrom` / `receivedTo`) and the bar shows the count from `bulk/count`; the filter, not ids, goes to every command.
- Reprocess and restore show progress ("Processed X, Y left") and can be stopped between calls; approval goes through a confirm dialog with the count and the number of trades left out.
- Every string through `useTranslations`; English first, pseudo-locale regenerated, every other locale translated.

## Checks

`backend/`: lint, `tsc --noEmit`, `typecheck`, `test:changed`, `build && test:integration` (new queries). `frontend/`: lint, type-check, i18n:check, test:changed, build.
