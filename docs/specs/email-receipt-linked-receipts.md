# Spec: linked email receipts (many emails, one transaction)

Status: **proposed**. The plan is
[`../future-plans/email-receipts-linked.md`](../future-plans/email-receipts-linked.md);
the base rules are [`email-receipt-matching.md`](./email-receipt-matching.md)
(units, amount grammar, matching, completeness, proposal). Everything in that
spec holds unless this one says otherwise.

Related: INV-RECEIPT-003 (a receipt changes the ledger only through an approved
card), INV-RULE-001, `docs/financial-calculation-contract.md` section 7
(rejection before write), `docs/financial-semantics.md` section 5 (splits).

---

## 1. Problem

One email enriches at most one bank transaction, and one transaction takes data
from at most one email. A deferred payment breaks this:

- A **purchase email** (the shop's order confirmation, paid with a deferred
  payment method) lists every item, price, shipping and discount. No bank
  transaction exists for it on that day.
- Weeks later a **repayment email** (the deferred-payment provider) names one
  bank transaction for its total. It covers one or more purchases, but per
  purchase it shows only the amount, the seller and the first product name.
- Both emails carry the same **key** per purchase (a contract number, an order
  number).

The repayment email finds the bank transaction; the purchase emails have the
detail. Neither alone gives an itemized split. The same shape covers a payment
gateway confirmation plus the shop's order email, and a marketplace order paid
in one charge and described in several emails.

## 2. Profile roles

A profile (`email_receipt_parsers.definition`, version 2) has an optional
top-level `role`:

| `role` | Reads | Looks for a bank transaction | Stored status |
|---|---|---|---|
| `standalone` (default, absent) | as today | yes (spec "Matching") | as today |
| `component` | as today, plus `linkKey` | **no** | `component` |
| `settlement` | as today; each item is one **part** and may capture `{link}` | yes, as today | as today (`review`, `unmatched`, ...) |

### 2.1 `component`

- `linkKey`: a list of field entries (a line pattern or a labelled
  `{label, value, within}`), read like `orderId`; the capture is `{link}`. For
  example `{label: "Umowa Allegro Pay", value: "{link} (umowa*"}` and
  `"Allegro Pay {link}"`.
- The **link value** is the capture with whitespace removed and lowercased;
  1 to 100 characters. A component with no link value read is `parse_failed`,
  reason `no_link_key`.
- A component never searches for a transaction and never opens a review
  request. Its status is `component`, its reason `awaiting_settlement` (no
  settlement uses it yet), `settled` (used, nothing left) or `instalment`
  (used, an amount is still left: section 4.3).
- `match` is ignored on a component (not an error, so switching a profile's
  role does not need other edits).
- Its categories come from its own profile's rules, at its own parse, as today.

### 2.2 `settlement`

- Every item of the items section is a **part**. An item pattern or record step
  may capture `{link}` (the part's link value, normalized as above) and
  `{instalment}` (free text such as `1. spłata z 3`, trimmed, at most 50
  characters, copied into the split memo of the scaled lines).
- Optional section `link`:
  - `fromDomains`: 1 to 10 sender domains (the profile domain rules) that the
    component search is limited to; absent means any sender.
  - `daysBefore`: 0 to 365, default 120: how far before the settlement's date a
    component may be dated. A component may also be dated up to 7 days after it
    (`LINK_DAYS_AFTER`, a constant: a gateway notice and a shop email cross).
    Both dates are `original_sent_at ?? received_at`.
- Matching the bank transaction is unchanged (spec "Matching", the profile's
  `match` section), except section 6 (conflicts).

### 2.3 Validation (codes)

| Code | When |
|---|---|
| `role_invalid` | `role` is not one of the three |
| `link_key_requires_component` | `linkKey` without `role: "component"` |
| `link_key_missing` | `role: "component"` without `linkKey` |
| `link_capture_requires_settlement` | `{link}` or `{instalment}` in an item pattern or record step without `role: "settlement"` |
| `link_requires_settlement` | a `link` section without `role: "settlement"` |
| `link_domain_invalid` | a `link.fromDomains` entry that the profile domain rules refuse, or more than 10 |
| `link_days_invalid` | `link.daysBefore` not an integer 0 to 365 |
| `role_trade_conflict` | a `trade` section with a role other than `standalone` |

## 3. Finding the component of a part

For each part with a link value `L`, the component is the user's stored
receipt with:

- status `component` and `link_key = L`;
- `from_domain` in `link.fromDomains` when that is given;
- its date inside `[settlement date - daysBefore, settlement date + 7]`.

Several hits: the newest date first, ties by id; only the first is used and
the part reports `several` with the count (two purchase emails with one key are
a resend). None: the part reports `not_found`.

## 4. The join (`joinSettlement`)

A pure function. Input: the settlement's `ParsedReceipt`, and for each part the
component found (its `ParsedReceipt`, id, profile tag) and the amount other
settlements already took from it (`taken`, section 4.3). Output: a new
`ParsedReceipt` whose items are the joined lines, plus one report per part.
Matching, completeness, the proposal, the review card and `confirm` read the
joined receipt exactly as they read a single email today; nothing downstream
knows a join happened, except the auto-apply gate (section 7).

### 4.1 Lines

A component's lines are its items, then its shipping, each fee, then its
discount, with the categories its own profile gave them (shipping:
`shippingCategoryId`, fees: `feesCategoryId`, discount: `discountCategoryId`).
`ParsedReceiptItem` gains an optional `kind`: absent or `"item"`, `"shipping"`,
`"fee"` or `"discount"`. A `discount` line counts against the total
(completeness subtracts it; the proposal signs it the opposite way). A stored
receipt without `kind` reads as before.

`N`, the component's **net**, is the sum of its lines (discount subtracted).
`R = N - taken` is what is left of it. `a` is the part's amount.

### 4.2 Truth table, per part

| Part has `{link}` | Component | Component complete | `a` against `R` | Part becomes | Report |
|---|---|---|---|---|---|
| no | -- | -- | -- | the part, one line | `no_link` |
| yes | none | -- | -- | the part, one line | `not_found` |
| yes | found | no | -- | the part, one line | `component_incomplete` (+ its reason) |
| yes | found | yes | `R <= 0` | the part, one line | `component_used` |
| yes | found | yes | `a = N` and `taken = 0` | the component's lines, unchanged | `joined` |
| yes | found | yes | `a < R`, or `a = R` with `taken > 0` | the component's lines scaled to `a` | `scaled` |
| yes | found | yes | `a > R` | the part, one line | `amount_exceeds` |

A part kept as one line keeps its own name and category (the settlement
profile's rules), exactly as today. The joined receipt's `paid` and `total`
are the settlement's own; its `orderId`, `reference` and `payee` are the
settlement's own.

### 4.3 Scaling (instalments)

Integer 1/10000 units, never floats, and whole cents (multiples of 100 units),
because the lines become splits. For each line `l` (signed: a discount is
negative), `s(l) = round_half_away_from_zero(l * a / (N * 100)) * 100`,
computed with `BigInt` (the product can exceed 2^53). The rest, `a - sum(s)`,
goes to the line with the largest positive `s` (ties: the first). A line scaled
to 0 is dropped. The sum of the scaled lines is exactly `a`.

The split memo of each scaled line is the line's memo followed by
` (` + the part's `{instalment}` text + `)` when the part captured one (the
email's own words, so it needs no translation); otherwise the memo is
unchanged.

`taken` is the sum of `part_amount` over the link rows (section 5) of OTHER
settlement receipts whose `component_receipt_id` is this component. After the
join the component's reason is `settled` when `taken + a >= N`, else
`instalment`.

### 4.4 Example: two purchases in one repayment

Repayment 272,89 zł: part 1 link `2268849427`, 109,89 zł, `BRIO ...`; part 2
link `1858316471`, 163,00 zł, `KOPI LUWAK ...`. Stored component for
`1858316471`: `KOPI LUWAK 250 g x 2` 150,00 + shipping 13,00, net 163,00,
complete. No component for `2268849427`.

Joined lines: `BRIO ...` 109,89 (the part, its profile category), `KOPI LUWAK
250 g x 2` 150,00, shipping 13,00. Sum 272,89. Transaction -272,89: splits
-109,89, -150,00, -13,00. Reports: `not_found`, `joined`. Status `review`,
reason `partially_linked`.

### 4.5 Example: instalments

Component net 300,00: item A 200,00, item B 100,00. Three settlements of 100,00
each, processed in date order.

| Settlement | `taken` | `R` | Case | A | B | Sum | Component reason |
|---|---|---|---|---|---|---|---|
| 1 | 0,00 | 300,00 | `a < R`: scaled | 66,67 | 33,33 | 100,00 | `instalment` |
| 2 | 100,00 | 200,00 | `a < R`: scaled | 66,67 | 33,33 | 100,00 | `instalment` |
| 3 | 200,00 | 100,00 | `a = R`, `taken > 0`: scaled | 66,67 | 33,33 | 100,00 | `settled` |

A: `200,00 * 100,00 / 300,00 = 66,666...`, rounded to 66,67; B: `33,333...`,
rounded to 33,33; the rest is 0. Each transaction is exact to the cent. Over the
three, A is 200,01 and B 99,99: the per-item total over instalments is not
exact, by design.

A discount is scaled the same way: component item 100,00, discount -10,00, net
90,00; a part of 45,00 gives 50,00 and -5,00.

## 5. Data

- `email_receipts.link_key VARCHAR(100) NULL`: the link value of a receipt
  whose status is `component`; null otherwise. Index
  `(user_id, link_key) WHERE link_key IS NOT NULL`.
- `email_receipts.status` CHECK gains `component`.
- New table `email_receipt_links`, one row per part of a settlement receipt:

```
id UUID PK, user_id UUID NOT NULL -> users ON DELETE CASCADE
settlement_receipt_id UUID NOT NULL -> email_receipts ON DELETE CASCADE
part_index INTEGER NOT NULL (0..99)
link_value VARCHAR(100) NULL        -- null: the part captured no {link}
part_amount NUMERIC(20,4) NOT NULL  -- the part's amount, >= 0
component_receipt_id UUID NULL -> email_receipts ON DELETE SET NULL
outcome VARCHAR(30) NOT NULL        -- the report of section 4.2
created_at, updated_at
UNIQUE (settlement_receipt_id, part_index)
INDEX (user_id, link_value) WHERE component_receipt_id IS NULL AND link_value IS NOT NULL
INDEX (component_receipt_id) WHERE component_receipt_id IS NOT NULL
```

  RLS: a direct table (`user_id`), policy and `ENABLE ROW LEVEL SECURITY` in
  the same migration. Backup: excluded, like `email_receipts` (a copy of mail
  the user can re-read).
- The rows of a settlement are replaced (delete, then insert) in the
  transaction that stores its new state, every time it is read past the parse.
  `component_receipt_id` is set only for `joined` and `scaled`. An ignored or
  deleted settlement has no rows (ignore deletes them in its transaction;
  delete cascades), so it takes nothing from a component.
- The joined receipt is stored in the settlement's `parsed`, with
  `parsed.links`: one entry per part `{partIndex, link, partAmount, outcome,
  componentReceiptId, componentReason?}`. The parts themselves are not stored:
  the pipeline reads the email again each time.

## 6. Matching a settlement: conflicts

A transaction that already has an applied email-receipt request is not a
candidate today. For a **settlement** profile, such a transaction IS a
candidate, carrying the id of the receipt whose request was applied
(`enrichedBy`). When the matcher picks it:

| The applied request's receipt is now | Result |
|---|---|
| a `component` that this settlement joins (`joined` or `scaled`) | proposed as usual: the new card replaces the earlier enrichment (the earlier receipt keeps its `transaction_id`) |
| anything else | `review_conflict`, reason `enriched_by_other`, `candidate_transaction_ids` = that transaction; the receipt page names the other email and offers the existing Link action, which proposes over it |

An open request on the transaction still gives `review_conflict` as today.

**Sign.** An automatic match only ever picks an expense (`amount < 0`), in
every strategy (spec "Matching"). A manual link is not limited.

## 7. Proposal and auto-apply

- The proposal is `buildReceiptProposal` over the joined receipt.
- Tags: the settlement profile's tag and the tag of each joined component's
  profile, without duplicates (case-insensitive), in that order; added only
  when the proposal categorizes, as today.
- **Auto-apply never applies a proposal with a `joined` or `scaled` part.** A
  person approves every join (the gate gains a `linked` fact).

## 8. When a component arrives after its settlement

After the transaction that stores a component (status `component`) commits,
the pipeline looks up the settlement receipts with a link row for its link
value and no component (`component_receipt_id IS NULL`), at most 20, and
processes each again, each in its own transaction, after the commit (never
inside the component's transaction). Errors are logged and do not fail the
component.

| Settlement's request | What happens |
|---|---|
| none, or open (`pending`, `proposed`) | an ordinary reprocess: matched again, joined, a new card |
| `applied` | **re-join**: the transaction is the settlement's own `transaction_id` (no new match); a new card is proposed on it; status `review`; the person confirms, and `confirm` replaces the split set |

A re-join runs only when the new join changes some part from `not_found` to
`joined` or `scaled`; otherwise nothing is written.

## 9. Re-reading an email as a component

A component reading never writes the ledger and never opens a request. An email
whose chosen profile is a `component` is therefore read as one even when its
earlier request was applied (the old standalone purchase profile): the applied
request is left as it is, `transaction_id` is kept, the status becomes
`component`. `process-batch` and a profile's `reprocessableCount` include such
emails (status `review`, `link_key` null, the domain of an approved component
profile).

## 10. The `test` operation

- On a component email: `linkKey` (the value and its trace hit), and
  `match: {outcome: "component"}`, plus `waitingSettlements` (id, subject,
  date) whose link rows wait for this key.
- On a settlement email: per part, `link`, the component found (id, subject,
  date, profile name) or none, `partAmount`, `componentNet`, `taken`, the
  report, and the joined lines; then the match against the joined receipt as
  today. The test reads with the same loader and the same `joinSettlement` as
  the pipeline, without row locks.

## 11. Concurrency

Lock order in a settlement's transaction: its own receipt row, then the found
component receipt rows `FOR UPDATE` in ascending id, then the advisory lock on
the matched transaction. A component's transaction locks only its own row and
never a settlement's (section 8 runs after its commit). So two settlements of
one component (instalments) compute `taken` one after the other.

## 12. Missing-data policy

- No component stored: the part is one line, as today; the receipt says which
  link values are missing (`partially_linked`, the parts' `not_found`).
- Component incomplete: the part is one line; the report names the component
  and its reason.
- A component with a different amount: `amount_exceeds`; the report shows both
  amounts.

## 13. Test matrix

| # | Case | Expected |
|---|---|---|
| 1 | Settlement 272,89 with parts 109,89 (no component) and 163,00 (component 163,00) | lines: part 109,89 + the component's lines; sum 272,89; `partially_linked` |
| 2 | Settlement 62,35, one part, component of three items summing 62,35 | the three items; `joined` |
| 3 | Settlement 1095,08 with parts 150,00 and 945,08, both components stored | every component line; sum 1095,08 |
| 4 | Component stored after its settlement, settlement proposed | reprocess, new card with the component's lines |
| 5 | Component stored after its settlement, settlement applied | re-join card on the settlement's transaction |
| 6 | No component at all | equal to a single-email reading |
| 7 | Component 300,00 (200,00 + 100,00), three settlements of 100,00 | each 66,67 + 33,33; reasons `instalment`, `instalment`, `settled` |
| 8 | A part of 400,00 against a component of 300,00 | one line, `amount_exceeds` |
| 9 | A component with a discount | discount line negative, sum exact |
| 10 | Transaction applied by the old standalone purchase receipt, that receipt now a component of the settlement | proposed over it |
| 11 | Transaction applied by an unrelated receipt | `review_conflict`, `enriched_by_other` |
| 12 | An expense email and a `+249,00` transaction | never matched |
| 13 | Each validation code of 2.3 | refused with that code |
| 14 | A joined proposal with auto-apply on | not applied |
| 15 | `test` on a component and on a settlement | the shapes of section 10 |
