# Email receipts: linked receipts, task list

> Companion to [`email-receipts-linked.md`](./email-receipts-linked.md) and
> [`docs/specs/email-receipt-linked-receipts.md`](../specs/email-receipt-linked-receipts.md).
> Definition of done per task is the layer's "Required before you push" list in
> `AGENTS.md`.

| ID | Task | Depends on | Status |
|----|------|-----------|--------|
| L0 | Backend: an automatic match picks only an expense (spec 6, "Sign") | - | done |
| L1 | Docs: spec, plan, task list | - | done |
| L2 | Backend: parser language (`role`, `linkKey`, `{link}`, `{instalment}`, `link`), validation codes, parse, tool guide and schema | L1 | done |
| L3 | Backend: `joinSettlement`, line `kind` in completeness and the proposal, tags, auto-apply `linked` | L2 | done |
| L4 | Database and backend: migration, entities, component and settlement paths in the pipeline, link rows, conflicts | L3 | done |
| L5 | Backend: a late component re-joins its settlements; a component re-reads an applied email; batch and reprocessable count | L4 | done |
| L6 | Backend: the `test` operation for components and settlements | L4 | done |
| L7 | Frontend: status `component`, reasons, parts and components on the receipt page, the conflict | L4 | done |
| L8 | i18n: English, pseudo-locale, every other locale | L2, L7 | done |
| L9 | Backend: draft requests over up to 5 domains (5 emails per domain), the multi-domain instruction, a request that holds one draft per domain (spec 10a) | L6 | done |
| L10 | Backend: `componentDrafts` in the parser `test` (spec 10a) | L9 | done |
| L11 | Frontend and i18n: selecting up to 5 emails per domain over up to 5 domains, a request with several drafts; every locale | L9 | open |
