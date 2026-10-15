# Email receipts: trade confirmations create investment transactions

Companion to [`email-receipts.md`](./email-receipts.md) (the feature this extends)
and `docs/financial-semantics.md` (how an investment transaction is booked).

Status: **implemented on a fork branch, not approved upstream.** It extends a
feature whose own discussion (kenlasko/monize#930) has no `approved-to-build`
label; the maintainer decides whether and in what slices it merges.

## 1. Goal

A brokerage emails "Your order has been filled" for every trade. Today the
Email Receipts feature cannot read it: it enriches a bank transaction that
already exists (split, category, payee), and a trade has no such transaction;
the trade itself is what is missing from the ledger. This extension reads the
confirmation with a saved profile and proposes the **investment transaction to
create**: account, buy or sell, security, shares, executed total, date. A person
approves it in the review inbox like any other proposal; an opt-in switch can
apply it unattended, under a stricter gate than a receipt's.

Out of scope: dividends, reinvestments, splits, transfers, option and crypto
confirmations (the reader knows `buy` and `sell` only); several fills in one
email; the profile form editor (a trade profile is written in the profile
editor's JSON mode, by the wizard or by the assistant).

## 2. Decisions

1. **A profile with a `trade` section is a trade profile.** The section holds the
   fields below and the profile holds nothing else of a receipt's (`trade_conflict`
   from the validator), so one email is never both. `requireLine`, `skipIfLine`,
   `waitIfLine` and `source` still apply.
2. **The proposal is a new queue kind, `email_trade`.** It has no transaction (there
   is none yet) and carries the email (`email_receipt_id`). It is born claimed by
   the receipts module's own key, `email-receipts`, so an agent never sees it
   pending. Its proposal is the signed `create_investment_transaction` card the
   chat's investment tool builds, carrying the request's id so confirm marks the
   request applied in the write's own transaction.
3. **The executed total is the fact; the price follows it** (INV-TRADE-001). The
   proposal carries quantity and total, never a price: the same preview that the
   chat uses derives the price at the column's ten decimals. The email's average
   price is only a cross-check.
4. **The account comes from the profile**: `accountRules` map the account text the
   email prints (`Account: RRSP`) to the user's INVESTMENT account, with a
   `defaultAccountId`. The security is found by ticker among the user's own
   securities, strictly (the ticker, or the ticker plus an exchange suffix:
   `XCNS` finds `XCNS.TO`), never by name or fragment, and never by a guess between
   several.
5. **A trade already in the ledger is not proposed again.** The same account,
   direction, security, day and exact share count (VOID rows ignored) makes the
   email `ignored` with `status_reason` `trade_exists`.
6. **Auto-apply is the mailbox's existing switch, with a stricter gate** (section 5).
7. **A trade that pays a scheduled bill or deposit marks it paid** (section 4.1).
8. **A trade email is linked to the transaction it reports, not to a bank
   transaction** (section 4.2), and can be recognized by the AI (section 4.3).

## 3. The profile section

```json
{
  "version": 2,
  "requireLine": ["Your order has been filled"],
  "trade": {
    "account":  ["Account: {account}"],
    "action":   ["Type: {action}"],
    "symbol":   ["Symbol: {symbol}"],
    "quantity": ["Shares: {quantity}"],
    "price":    ["Average price: {amount}"],
    "total":    ["Total cost: {amount}"],
    "date":     ["Time: {date}"],
    "accountRules": [
      { "match": "RRSP", "accountId": "<uuid of the RRSP investment account>" },
      { "match": "TFSA", "accountId": "<uuid of the TFSA investment account>" }
    ]
  }
}
```

Every field is a list of entries read exactly like a receipt field (a line
pattern or a labelled `{label, value, within}`, tried in array order, rule globs
only). The capture each takes: `action`, `symbol`, `quantity`, `date`, `account`;
`total`, `price`, `commission` take `{amount}`.

| Field | Required | Meaning |
|---|---|---|
| `action` | yes | Text that names the direction: a word `buy`/`bought` or `sell`/`sold` (case-insensitive); both or neither is no reading |
| `symbol` | yes | The ticker as the broker prints it |
| `quantity` | yes | Shares, digits with at most 8 decimals; a comma is a thousands separator |
| `total` or `price` | one of them | The executed total (commission included for a buy), or the average price per share |
| `commission` | no | Commission; a buy's total includes it, a sell's proceeds are net of it |
| `date` | no | `YYYY-MM-DD` or `Month D, YYYY`; time and zone are ignored (the broker's own day). Without it, the day the email arrived (the shop's day for a forward) |
| `account` + `accountRules` | one of this or `defaultAccountId` | The account text and the rules that map it (first match wins) |

Bounds: the receipt parser's (200 characters a pattern, 10 entries a field), at
most 20 `accountRules`. The validator's new codes: `trade_conflict` (a receipt
field beside `trade`), `trade_amount_missing` (neither `total` nor `price`),
`trade_account_missing` (no way to decide the account); plus the existing
`empty`, `invalid_uuid`, `capture_not_allowed` and `unknown_key` at the
`trade.*` paths.

### 3.1 Reading and completeness

`complete` is true only when the action, symbol, quantity and an amount were read
and an account was decided. The first missing thing is the reason
(`trade_no_action`, `trade_no_symbol`, `trade_no_quantity`, `trade_no_amount`,
`trade_no_account`), and the email is `parse_failed` with it.

`consistent` cross-checks the email against itself when it states a price and a
total. With `q` shares, a price written with `d` decimals, a total `T` and a
commission `c`, the gross is `T - c` for a buy and `T + c` for a sell, and the
reading is consistent when

    | q * price - gross |  <=  q * 0.5 * 10^-d  +  0.01

(price rounding plus one cent), in integer arithmetic (shares in 1e-8 units as a
BigInt, money in 1/10000). `consistent` is `null` when the email states no price
or no total: nothing to check.

Numerical example (the email in the fixture
`backend/src/email-receipts/parsing/fixtures/wealthsimple-trade.ts`): 75.9878
shares at $26.32 is 1999.998896 against a stated total of 2000.00. The
difference, 0.0011, is inside `75.9878 * 0.005 + 0.01 = 0.39`, so the reading is
consistent. A price of $31.00 gives 2355.62: inconsistent.

An email that states only a price is proposed with the total that price implies,
to the ledger's four decimals (`75.9878 * 26.32 = 1999.9989`); it is never
`consistent` and so never auto-applies.

## 4. Pipeline

```
poll/process -> choose parser (as before)
             -> the parser has `trade`:
                  read the lines            -> incomplete: parse_failed (reason)
                  already booked            -> ignored (trade_exists)
                  close the email's open requests, queue an email_trade request
                  submit the card           -> refused: review + proposal_refused,
                                               request rejected with the reason
                                            -> stored: review, request proposed
                  opt-in gate               -> confirm the same card
```

The refusals the card build can raise (and the proposal then shows): the account
is not the user's INVESTMENT account; the ticker is none of the user's securities
or is ambiguous; the position cannot cover a sell. They are raised at proposal
time and again whenever the inbox rebuilds the card, so a stale proposal says why
it can no longer be applied instead of failing the list.

`email_receipts.trade` (JSONB, nullable) stores the reading; `parsed` is null
for a trade email. The receipts page shows the reading in the detail dialog; the
review inbox shows the row as "Buy N shares of SYMBOL" with the card.

### 4.1 A scheduled bill or deposit the trade pays

When the card is built, `ScheduledTransactionsService.findInvestmentOccurrenceForTrade`
looks for the one active scheduled investment transaction of the same account,
direction and security whose next occurrence is due within 7 days of the trade's
day and whose commission equals the trade's. Exactly one, or none: with two, which
bill the trade paid is a guess, and a guess marks the wrong one paid.

A match is part of the signed card (`scheduledTransactionId`, the due date the
card was built for, and the schedule's name on the card). Approving it does NOT
create a second row: confirm posts that occurrence through
`ScheduledTransactionsService.post` with the card's figures (date, shares, the
price the executed total implies, description), inside the one transaction that
also marks the request applied (`beforeWrite`). The post creates the investment
transaction exactly as the schedule would, claims the occurrence and advances the
schedule. A schedule that moved on since the card was built refuses with a
conflict and nothing is written. The card is rebuilt on every inbox read, so it
shows the schedule as it is now.

### 4.2 Linking a trade email

A trade email is not matched to a bank transaction, so "Link" means "this email
is that existing transaction". The detail dialog lists the user's own non-VOID
investment transactions of the trade's account, direction and ticker within 7
days of its day (`EmailReceiptTradeLinkService.candidates`); linking one closes the
email as `ignored` with `status_reason` `trade_linked`, dismisses its open request
and, when a scheduled bill or deposit that trade pays is not yet paid (the matching
rule of 4.1, applied to the linked transaction's own figures), marks the occurrence
paid with `ScheduledTransactionsService.post(..., { recordOnly: true })`: the
occurrence is claimed and the schedule advances, and no money is written, because
the payment is already in the ledger. All in one transaction. An occurrence paid in
the meantime is not an error. Linking is allowed from `ignored` (an email closed as
`trade_exists`), which is when it matters most, but not once the proposal was
applied.

### 4.3 Recognize as a trade with AI

An email no profile read as a trade (or one whose proposal was refused) can be
sent to the assistant as a trade: `POST /email-receipts/:id/ask-ai` with
`{ asTrade: true }` queues a `pending` request of kind `email_trade` (no
transaction; `RECEIPT_TRADE_CHAT_INSTRUCTION`), and the receipts page stages the
chat with the email attached. The assistant claims it by id (the claim returns the
email and no transaction) and answers with `ai_review_requests` `submit` and the
`trade` field: `accountName` (an investment account), `action`, `symbol`,
`quantity`, `totalAmount`, optional `commission`, `date` (else the email's day) and
`description`. The account is found by name; the rest goes through the same card
build as a profile's trade, so the same refusals apply, and a person approves the
card. `submit` accepts the `trade` field for this kind only, and refuses it for
any other; a request a profile queued is born claimed by the receipts key, so no
agent can answer it.

### 4.4 Profile tooling

- **Test and the assistant's tool.** `POST /email-receipt-parsers/test` and the
  `email_receipt_parsers` tool's `test` return, for a trade profile, `trade` (what
  it read, `complete`, `consistent`) and its trace, and no match. `categories`
  also returns `investmentAccounts` (id and name) for `accountRules`; the language
  guide it returns teaches the trade section.
- **Preview.** A complete trade is the outcome `trade`; an incomplete one is
  `parse_failed` with the `trade_*` reason; each item carries `trade` (direction,
  ticker, shares, `consistent`). No bank transaction is looked up.
- **The wizard.** Step 1 has a switch "These are brokerage trade confirmations":
  the samples are emails alone (no transaction is paired), step 2 sends
  `{ kind: "trade", tradeReceiptIds }` to `POST /email-receipt-parsers/generate-with-ai`
  (the prompt, or the queued instruction for the user's own agent, asks for a trade
  profile, with the account mapping), and step 3 previews as above. Changing the
  switch clears the ticked emails.

## 5. The auto-apply gate

The mailbox switch (`auto_apply`) applies a trade only when ALL hold: the switch
is on; the profile is `approved`; the reading is complete; `consistent` is
`true` (a price was stated and agrees with the shares and the total); the card
was built (account and security resolved, preview valid); no trade of that
description exists. It then calls the same `/ai/actions/confirm` a person's
approval calls. Anything else waits in the inbox. The daily AI write limit counts
a trade (the exemption of a profile's proposal applies to `update_transaction`
only).

## 6. Invariants

INV-RECEIPT-008 (`docs/system-invariants.md`): a trade confirmation creates an
investment transaction only through the review card and the confirm path. This is
the one exception to INV-RECEIPT-003's "never moves money", and it is bounded the
same way: signed card, single-use, expiry, the request marked applied in the
write's own transaction.

The duplicate check is a read before the proposal, not a lock: a manual entry of
the same trade made between the proposal and its approval is not detected. The
person approving sees the card and the account; this is the same exposure the
chat's `create_investment_transaction` has.

## 7. Test matrix

| Layer | What |
|---|---|
| Reader (`parse-trade.spec.ts`) | The Wealthsimple email; a sell; each incomplete reason; price-only and total-only; the consistency table; share-count, direction and date grammars |
| Validator (same file) | Valid profile; each new code; wrong capture; unknown key in a rule |
| Pipeline (`email-receipt-pipeline.service.spec.ts`, `email-receipt-trade.service.spec.ts`) | Branch to the trade service; no bank-transaction lookup; request closed when none is held; duplicate; conflict; refusal; each auto-apply gate condition |
| Queue (`ai-review-requests.service.spec.ts`) | `enqueueTrade` conflict clause; `markTradeApplied` predicate and 409 |
| Card (`ai-review-work.service.spec.ts`) | Strict ticker; total passed as the fact, no price; refusals; inbox rebuild; approval; agents cannot answer the kind |
| Confirm (`ai-actions.service.spec.ts`, `investment-transactions.service.spec.ts`) | The hook runs first, on the write's manager; a refusal writes nothing; a card that pays a schedule posts the schedule instead of creating a row |
| Schedule (`scheduled-transactions.service.spec.ts`) | The matching query's predicates, none and ambiguous; `beforeWrite` runs inside the post and a refusal writes nothing |
| Link and recognize (`email-receipt-trade-link.service.spec.ts`, `email-receipt-ai.service.spec.ts`, `ai-review-work.service.spec.ts`) | Candidates; link closes the email, marks the schedule paid with no money, tolerates a paid-in-the-meantime conflict; the trade request queued pending; an agent's trade, account by name, date fallback |
| Tooling (`email-receipt-parser-tools.service.spec.ts`, `email-receipt-parser-preview.service.spec.ts`, `email-receipt-parser-generate.service.spec.ts`, `parser-generate-prompt.spec.ts`) | Trade test result and `investmentAccounts`; the `trade` preview outcome; the trade generate request |

Not covered by a unit test: the migration against a real PostgreSQL
(`scripts/verify-schema.sh`) and the integration suites, which need Docker.
