# Email receipts: linked receipts, task list

> Companion to [`email-receipts-linked.md`](./email-receipts-linked.md) and
> [`../specs/email-receipt-linked-receipts.md`](../specs/email-receipt-linked-receipts.md).
> Definition of done per task is the layer's "Required before you push" list in
> `AGENTS.md`.

| ID | Task | Depends on | Status |
|----|------|-----------|--------|
| L0 | Backend: an automatic match picks only an expense (spec 6, "Sign") | - | done |
| L1 | Docs: spec, plan, task list | - | done |
| L2 | Backend: parser language (`role`, `linkKey`, `{link}`, `{instalment}`, `link`), validation codes, parse, tool guide and schema | L1 | open |
| L3 | Backend: `joinSettlement`, line `kind` in completeness and the proposal, tags, auto-apply `linked` | L2 | open |
| L4 | Database and backend: migration, entities, component and settlement paths in the pipeline, link rows, conflicts | L3 | open |
| L5 | Backend: a late component re-joins its settlements; a component re-reads an applied email; batch and reprocessable count | L4 | open |
| L6 | Backend: the `test` operation for components and settlements | L4 | open |
| L7 | Frontend: status `component`, reasons, parts and components on the receipt page, the conflict | L4 | open |
| L8 | i18n: English, pseudo-locale, every other locale | L2, L7 | open |
