# Backups Off the Machine: Agent Task List

The task graph for `docs/future-plans/backup-off-machine.md`. The invariants are
`docs/specs/backup-off-machine.md`. Discussion #1369 (`approved-to-build`).

## How to use this list (read first, every session)

- **One task per session/PR.** Each task below is scoped to a single concern and
  names the files it may touch. Touching files outside that scope is a scope
  violation -- split it into its own task instead.
- **Link the discussion** (#1369) and name the invariant IDs in every PR.
- This feature touches shared area (`auto-backup.service.ts`, the backup docs). If
  the horizontal-scaling S2 task ("S3 as the backup store") is in flight, name it
  in your PR so the maintainer sequences the two -- they collide on the same file
  and config. See the plan's "Relationship to the horizontal-scaling plan".
- **Stage gate.** Do not start Stage 2 before Stage 1 is merged, or Stage 3 before
  Stage 2, unless the maintainer re-orders. Stages 2 and 3 are independently
  deferrable.

## Definition of done for every task

- `npm run lint && npx tsc --noEmit && npm run typecheck` clean (backend);
  `lint && type-check && i18n:check` clean (frontend).
- Unit tests green: `TZ=UTC npm run test:unit -- --coverage` at or above the
  layer thresholds.
- A **two-connection integration spec** where the claim is that a real S3 or
  PostgreSQL property holds (the round-trip and single-winner tasks): `npm run
  build && npm run test:integration`. A mocked S3 client proves the call, not the
  property -- use MinIO or a test bucket.
- A migration is mirrored into `database/schema.sql` in the same commit;
  `npm run migration:lint` and `scripts/verify-schema.sh` pass; new raw-SQL
  columns pass `raw-sql-columns.spec.ts`.
- New env vars are in `.env.example`; `node scripts/check-env-docs.mjs` passes.
- A new `@Cron` has its row in `docs/cron-jobs.md`.
- New invariants are added to **both** `docs/system-invariants.md` and
  `docs/verification-contract.md` section 3 (parity spec).
- English-first strings, then `npm run i18n:pseudo`, then every other locale as
  the final commit (i18n parity).
- New files staged (`git add -N`) before running the tree-walking guard specs.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
| --- | --- | --- | --- | --- |
| B1 | Compute the egress digest (SHA-256 of the exact bytes) in `exportToFile` and return it with `{ filename, report }`. No egress yet. Files: `backend/src/backup/auto-backup.service.ts` (+spec). Invariant: INV-BACKUP-005 (foundation). | -- | neutral | [ ] |
| B2 | Extract shared S3 transport (lazy client, `withDeadline`, key-safety) from `s3-storage.provider.ts` into a shared helper; both providers use it. No behaviour change. Files: new `backend/src/attachments/storage/*` helper, `s3-storage.provider.ts` (+specs). Invariant: none (refactor -- name it in the PR per shared-area rule). | -- | neutral | [ ] |
| B3 | `BackupOffsiteS3Uploader`: one conditional, checksummed `PutObject`; no delete/overwrite import. Files: new `backend/src/backup/*offsite*` + spec + guard spec. Invariant: INV-BACKUP-004. | B2 | neutral | [ ] |
| B4 | Migration + `schema.sql` for `backup_offsite_uploads`; RLS-scoped. Files: `database/migrations/*`, `database/schema.sql`, entity. Invariant: INV-BACKUP-005. | -- | new table | [ ] |
| B5 | Config plumbing: `BACKUP_OFFSITE_PROVIDER`, `BACKUP_S3_*` in `.env.example`; boot refusal when provider=s3 and bucket unset. Files: config, `.env.example`. Invariant: none. | -- | neutral (off by default) | [ ] |
| B6 | Dispatch egress after `applyBackupOutcome` for a complete, encrypted artifact, outside the export transaction, single-winner across replicas; write durable state. Files: `auto-backup.service.ts` (+spec), integration spec (MinIO). Invariant: INV-BACKUP-002, INV-BACKUP-003, INV-BACKUP-005. | B1, B3, B4, B5 | egress off by default | [ ] |
| B7 | Plaintext-refusal path + admin alert + source-scan guard that egress is unreachable from a `.json.gz` artifact. Files: dispatcher, alert, guard spec, i18n. Invariant: INV-BACKUP-002. | B6 | neutral | [ ] |
| B8 | Admin surface: per-user off-site status (key, digest, status, attempts). Files: controller/service, frontend, i18n (all locales). Invariant: none. | B6 | neutral | [ ] |
| B9 | Add INV-BACKUP-002..005 to `system-invariants.md` + `verification-contract.md` section 3 (may fold into B6/B7 if landed together). Files: the two docs. Invariant: all four. | B6, B7 | neutral | [ ] |
| R1 | Stage 2: conditional claim + reaper cron; bounded attempts + backoff; re-attempt under the same key; `cron-jobs.md` row. Files: dispatcher/reaper (+specs), two-connection integration spec, `docs/cron-jobs.md`. Invariant: INV-BACKUP-005 (retry). | B6 | new cron | [ ] |
| E1 | Stage 3: resolve attach-vs-link; add the send path bounded by `BACKUP_EMAIL_MAX_BYTES`, encrypted-only. Files: `email.service.ts` (+spec), config, `.env.example`, i18n. Invariant: INV-BACKUP-002, INV-BACKUP-005. | R1 | new config (off by default) | [ ] |

## Suggested order

1. **Neutral foundations (parallelizable):** B1, B2, B4, B5.
2. **Uploader:** B3 (after B2).
3. **Wire it up:** B6 (after B1, B3, B4, B5), then B7, then B9, then B8.
4. **Stage 2:** R1 (after Stage 1 merged).
5. **Stage 3:** E1 (after R1, and after the attach-vs-link open question is
   resolved with the maintainer).
