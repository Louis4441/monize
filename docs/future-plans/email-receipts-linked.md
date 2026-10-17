# Email receipts: linked receipts (many emails, one transaction)

> Companion to [`email-receipts.md`](./email-receipts.md) (the design),
> [`../specs/email-receipt-linked-receipts.md`](../specs/email-receipt-linked-receipts.md)
> (the spec: truth tables, examples, missing-data policy, test matrix) and
> [`email-receipts-linked-tasks.md`](./email-receipts-linked-tasks.md) (the task
> list). The invariants of the parent design apply unchanged: the mailbox is
> read, never written (INV-RECEIPT-001), and a receipt reaches the ledger only
> through the review card and `/ai/actions/confirm` (INV-RECEIPT-003).

## Why

A deferred payment ("buy now, pay later") splits what the user needs across two
emails: the shop's purchase email has every item but no bank transaction on its
day; the provider's repayment email has the bank transaction but only the first
product name of each purchase it repays. Both carry one key per purchase. Today
a profile can enrich a transaction from one of them only, and two profiles for
the two senders compete for the same transaction.

## Decisions

1. **Roles, not a new profile kind.** A profile's `role` is `standalone`
   (default), `component` (stored, never matched, exposes a `linkKey`) or
   `settlement` (matched as today; each item is a part that may capture
   `{link}`). Nothing is specific to one shop.
2. **The join is a pure function before the proposal.** `joinSettlement` turns
   the settlement's reading into a joined `ParsedReceipt`; matching,
   completeness, `buildReceiptProposal`, the review card and `confirm` are
   unchanged. The `test` operation calls the same function (a preview computes
   what the commit will do).
3. **Emails are linked to emails, not to transactions.** The transaction stays
   on the settlement's `transaction_id`; a new table `email_receipt_links`
   holds one row per part. It gives the reverse lookup (a component that
   arrives late finds the settlements waiting for it) and the amount already
   taken from a component (instalments). The prompt's
   `transaction_email_receipts` table is not needed.
4. **Statuses.** One new status, `component` (`status` is `VARCHAR(20)`, so
   `waiting_for_settlement` does not fit); everything else is a
   `status_reason`: `awaiting_settlement`, `settled`, `instalment` (component),
   `partially_linked` (settlement), `enriched_by_other` (conflict),
   `no_link_key`.
5. **Instalments work for every user**: a part smaller than what is left of its
   component scales the component's lines to the part, in whole cents, the rest
   on the largest line. The `{instalment}` capture copies the email's own words
   ("1. spłata z 3") into the memo.
6. **A person approves every join**: the auto-apply gate refuses a proposal with
   a joined or scaled part.
7. **Tags**: the settlement profile's tag and each joined component profile's
   tag, without duplicates.
8. **Conflicts are shown, not hidden.** For a settlement profile, an enriched
   transaction is a candidate; taken over automatically only when its earlier
   enrichment came from a component this settlement joins, otherwise
   `review_conflict` with `enriched_by_other` and the existing Link action.
9. **Sign.** An automatic match picks only an expense, in every strategy
   (shipped first, on its own).
10. **A component re-reads an applied email.** The old standalone purchase
    profile applied some purchase emails to repayment transactions; once that
    profile is a component, those emails are read again as components (no
    ledger write), so the settlement can take the transaction over.

## What to edit

| Layer | Files |
|---|---|
| Parser language | `backend/src/email-receipts/parsing/receipt-parser.types.ts`, `receipt-parser.validation.ts`, `receipt-items.ts`, `parse-receipt.ts`, `parsers/parser-tool.guide.ts` and the tool's input schema |
| Join and proposal | new `backend/src/email-receipts/linking/join-settlement.ts`, `proposal/build-receipt-proposal.ts`, `parsing/parse-receipt.ts` (`completeness`), `proposal/receipt-category-history.ts`, `pipeline/auto-apply-gate.ts` |
| Data | new migration, `database/schema.sql`, `entities/email-receipt.entity.ts`, new entity `email-receipt-link.entity.ts`, backup exclusion, RLS spec maps |
| Pipeline | `pipeline/email-receipt-pipeline.service.ts`, `pipeline/receipt-candidates.ts`, new `linking/component-lookup.ts`, `receipts/email-receipts.service.ts` (ignore, batch, reprocessable), `parsers/receipt-dry-run.ts` |
| Frontend | the receipts page status labels and filters, the receipt detail (parts and their components, conflict), types, `en` messages |
| i18n | `npm run i18n:pseudo`, every other locale as the last commit |

## What to run

`backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`,
`npm run test:changed`, `npm run migration:lint:test && npm run migration:lint`,
`npm run build && npm run test:integration` (migration, entity, queries).
Repository root: `scripts/verify-schema.sh` (Docker),
`node scripts/check-migration-prefixes.mjs`, `node scripts/check-docs-manifests.mjs`.
`frontend/`: `npm run lint && npm run type-check && npm run i18n:check`,
`npm run test:changed`, `npm run build`.

## What should be observed

With a component profile for the purchase emails and a settlement profile for
the repayment emails (both approved, the purchase emails re-read):

- a repayment covering two purchases, one of them stored, proposes the stored
  purchase's lines plus one line for the other (`partially_linked`);
- storing the missing purchase email later proposes a new card with both
  purchases' lines, on the same transaction, even after the first card was
  applied;
- no proposal with a join is applied without a person;
- tests in the repository use synthetic fixtures only; no real contract number,
  seller or product from a user's mailbox is committed.

## Assumptions

- Every amount in an email receipt is an expense; the module has no refund.
- A purchase email carries exactly one link key.
- The user re-reads stored purchase emails once after switching their profile
  to `component` (a profile's "Re-parse emails" counts them, decision 10).

## Left for later

- **A loan account for an instalment purchase.** When a component is paid in
  instalments (reason `instalment`), the user may prefer a dedicated loan
  account: the purchase booked on it with the full detail, each repayment a
  transfer from the bank. That is a different booking (repayments are
  transfers, which receipt matching skips), so it is its own design. This
  change only records the signal (`instalment`); a later change can offer
  "create a loan account for this purchase" (a hint on the receipt page or a
  notification), the account created by a person.
- Splitting one component across several settlements by item instead of by
  proportion.
