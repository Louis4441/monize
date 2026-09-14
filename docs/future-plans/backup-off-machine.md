# Plan: ship backups off the machine (S3 append-only, then email)

Staged plan for copying an automatic backup off the container it was written on.
The invariants are the approved spec `docs/specs/backup-off-machine.md`; this file
is the work breakdown, the configuration, the guards, and the rollout. The task
graph is `docs/future-plans/backup-off-machine-tasks.md`. Proposed in discussion
#1369 (`approved-to-build`).

## Goal

After a complete local automatic backup exists, place a copy of the same artifact
off the machine, so losing the backup volume is not losing every recovery point.
Three stages, each its own reviewable series of PRs:

1. **S3 append-only.** Upload the encrypted artifact to an S3-compatible bucket
   with a credential and code path that can add a new object but cannot overwrite
   or delete one. Integrity verified before the copy is recorded as done.
2. **Retry and lifecycle.** Durable per-artifact upload state with a conditional
   claim and a reaper, so a transient failure is retried rather than lost.
3. **Email.** Deliver a size-bounded encrypted artifact, or a link to one, to a
   configured address.

The local artifact stays primary: written first, read by restore, never replaced
or deleted by anything here.

## Relationship to the horizontal-scaling plan

`docs/future-plans/horizontal-scaling.md` reserves `BACKUP_STORAGE_PROVIDER`
(task S2) for making S3 the *storage* of the automatic backup -- replacing the
local volume, so the backup is written to S3 in the first place. This plan is a
different idea: the local volume stays the primary and S3 (or email) is an
*additional* copy taken afterward. The two can coexist, but their configuration
must not collide:

- This plan owns `BACKUP_S3_*` and `BACKUP_OFFSITE_*` (an egress copy).
- The horizontal-scaling plan owns `BACKUP_STORAGE_PROVIDER` (the primary store).
- If S2 lands first and S3 becomes the primary store, this plan's off-machine
  copy becomes redundant for that deployment and its dispatcher must no-op when
  the primary store is already off-machine. That interaction is an open question
  (below), to be resolved before Stage 1 WP3 is built if S2 is in flight.

Whoever builds first names the other in their PR so the maintainer sequences
them; they touch the same file (`auto-backup.service.ts`) and the same doc
section, so this is shared-area work under `CONTRIBUTING.md`.

## Why this is non-trivial here (current state)

- **The artifact write has no integrity record yet.** `INV-BACKUP-001` made the
  local write crash-atomic (temp -> fsync -> rename) and put the completeness
  verdict in the envelope, but there is still no content digest stored for the
  finished bytes. Egress needs one (the egress digest, INV-BACKUP-005), computed
  once over the exact bytes written locally and reused as the S3 checksum and the
  durable identity. This is a small addition to `exportToFile`, not a new
  pipeline.
- **The existing S3 provider is the wrong door.**
  `backend/src/attachments/storage/s3-storage.provider.ts` implements
  `save`/`load`/`delete` and imports `DeleteObjectCommand`. Reusing it whole would
  hand the egress path a delete it must never have (INV-BACKUP-004). The transport
  concerns (lazy client build, the aborting `withDeadline`, `assertSafeStorageKey`)
  are worth sharing; the mutation surface is not.
- **Encryption is conditional.** Automatic backups are `.mzbe` only when a usable
  backup password exists; otherwise `.json.gz`, in the clear, holding third-party
  API keys decrypted. Egress must refuse the plaintext case, loudly
  (INV-BACKUP-002) -- the same reason a support backup is unconditionally
  encrypted.
- **Email has no attachment mechanism.** `EmailService.sendMail(to, subject,
  html)` (`backend/src/notifications/email.service.ts`) carries no attachment
  parameter and no size bound, and artifacts are tens of MiB against typical SMTP
  ceilings. Stage 3 is therefore a real design question (attach vs link), not a
  wiring job -- deferred behind Stages 1-2.
- **Every replica fires the backup cron.** The dispatch and (Stage 2) the retry
  claim must be single-winner across replicas, the same way `claimDueBackup`
  already is, or a two-replica cluster uploads twice.

## Principles

- **Local first, copy after, outside the transaction.** Dispatch egress on the
  tail of a successful run, after `applyBackupOutcome`, never inside the export
  transaction -- the push-after-commit shape (`docs/external-side-effects.md`
  section 4a). An egress failure is never the backup's failure.
- **Verify, then record.** "Uploaded" is written only after the destination
  confirms the bytes by digest (EXT-002). Copy the emergency-access shape: the
  durable "it happened" marker is withheld until the external effect is confirmed,
  and withholding it *is* the retry (`docs/external-side-effects.md` section 5).
- **Append-only on two layers.** Operator IAM grants `s3:PutObject` only on a
  versioned, object-locked bucket; the app additionally never constructs a delete
  and puts with `IfNoneMatch: "*"`. Neither layer alone is trusted.
- **Encrypted or nothing.** Only `.mzbe` leaves the machine; a plaintext artifact
  yields a visible alert and no copy.
- **One digest, computed once.** The SHA-256 over the exact local bytes is the S3
  checksum, the key disambiguator, and the durable identity -- not three separate
  reads.
- **Off by default.** An un-configured deployment behaves exactly as today.

## Configuration

New variables, documented in `.env.example` mirroring the `ATTACHMENT_S3_*`
block, each commented-out with an example on the assignment line. New
`process.env` / `configService.get` reads are added to `.env.example` in the same
PR or `node scripts/check-env-docs.mjs` fails.

```text
# Whether to copy each complete automatic backup off the machine, and how.
# Off unless set. "s3" (Stage 1); "email" added in Stage 3.
BACKUP_OFFSITE_PROVIDER=s3

# --- s3 egress (append-only) ---
BACKUP_S3_BUCKET=my-monize-offsite            # required when provider=s3
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=backups/
BACKUP_S3_ENDPOINT=                           # MinIO/R2/B2; unset for AWS
BACKUP_S3_FORCE_PATH_STYLE=false
BACKUP_S3_ACCESS_KEY_ID=                       # a PutObject-only credential
BACKUP_S3_SECRET_ACCESS_KEY=
BACKUP_S3_REQUEST_TIMEOUT_MS=300000            # shorten-only, same as attachments
```

The `.env.example` comment for the credential states the append-only requirement
explicitly: the token's IAM policy grants `s3:PutObject` only, on a bucket with
versioning and object-lock (or an equivalent write-once rule), so a leaked token
cannot delete or rewrite existing recovery points. Stage 3 adds
`BACKUP_EMAIL_TO` and a `BACKUP_EMAIL_MAX_BYTES` bound.

## Work packages

Each names its mechanism, the invariant it serves, the test kind it owes, and its
deploy impact.

### Stage 1 -- S3 append-only

**WP1. Egress digest at write time.** Compute the SHA-256 of the exact bytes in
`exportToFile` after the atomic rename, return it alongside `{ filename, report }`.
No behaviour change when egress is off. *Invariant: INV-BACKUP-005 (foundation).
Tests: unit -- the digest matches the file. Deploy impact: neutral.*

**WP2. Shared S3 transport, distinct egress uploader.** Extract the lazy client
build, `withDeadline`, and key-safety from `s3-storage.provider.ts` into a shared
helper both providers use; add a `BackupOffsiteS3Uploader` that has one operation
-- a conditional, checksummed `PutObject` -- and imports no delete/overwrite
command. *Invariant: INV-BACKUP-004. Tests: unit -- no overwrite; guard -- no
DeleteObjectCommand import. Deploy impact: neutral (unused until WP3).*

**WP3. Dispatch + durable state.** Add `backup_offsite_uploads` (migration +
`schema.sql`), and dispatch egress after `applyBackupOutcome` for a complete,
encrypted artifact, under the user's context and outside the export transaction.
Single-winner across replicas. Records `uploaded` only on a verified put.
*Invariant: INV-BACKUP-002, INV-BACKUP-003, INV-BACKUP-005. Tests: unit (dispatch
gating, plaintext refusal) + integration (real MinIO/test bucket round-trip,
corrupted-body rejection, re-run no-op). Deploy impact: new table; egress off by
default.*

**WP4. Encryption-before-egress guard + alert.** The plaintext-refusal path and
its `BACKUP_PARTIAL`-class admin alert, plus the source-scanning guard that egress
is unreachable from a `.json.gz` artifact. *Invariant: INV-BACKUP-002. Tests:
unit + guard. Deploy impact: neutral.*

**WP5. Admin surface.** Show per-user off-site status (last object key, digest,
status, attempts) on the existing admin backup surface; i18n for every new string,
English-first then pseudo-locale then parity. *Invariant: none new. Tests:
frontend unit + i18n parity. Deploy impact: neutral.*

### Stage 2 -- retry and lifecycle

**WP6. Claim + reaper.** Move the `failed`/`pending` rows through a conditional
claim (`UPDATE ... WHERE status IN (...) RETURNING`, one replica wins) and a
reaper cron that re-attempts under the same key, bounded attempts, backoff. Add
the `@Cron` row to `docs/cron-jobs.md`. The state machine gains the
"externally-done, not-yet-finalized" state
`docs/external-side-effects.md` section 7 calls for. *Invariant: INV-BACKUP-005
(retry half). Tests: two-connection integration (one winner; a retry of an
uploaded artifact is a no-op). Deploy impact: new cron.*

### Stage 3 -- email

**WP7. Email delivery.** Resolve the attach-vs-link question (below), add the
attachment-carrying send or the link path to `EmailService`, bound by
`BACKUP_EMAIL_MAX_BYTES`, encrypted-only (INV-BACKUP-002). *Invariant:
INV-BACKUP-002, INV-BACKUP-005. Tests: unit + integration. Deploy impact: new
config; off by default.*

## Invariants to add

Reserved here; each is added to `docs/system-invariants.md` **and**
`docs/verification-contract.md` section 3 by the PR that first enforces it (both
files together, or `invariant-catalog-parity.spec.ts` fails). Full text in
`docs/specs/backup-off-machine.md` section 4.

| ID | Statement | Mechanism | Test kind |
| --- | --- | --- | --- |
| INV-BACKUP-002 | Only an encrypted artifact leaves the machine | extension/envelope check in the dispatcher + source-scan guard | unit + guard |
| INV-BACKUP-003 | A complete local copy exists before any off-machine copy | dispatch after `applyBackupOutcome`, outside the transaction | unit |
| INV-BACKUP-004 | The app cannot delete or overwrite an off-machine copy | PutObject-only IAM + no delete import + `IfNoneMatch` | guard + unit |
| INV-BACKUP-005 | An off-machine copy is verified before it is recorded done | checksummed PutObject + durable state | integration |

## Guards to add

- A `*.guard.spec.ts` that the off-site uploader imports no `DeleteObjectCommand`
  and issues no unconditional (overwrite-capable) `PutObject` (INV-BACKUP-004).
- A `*.guard.spec.ts` that no egress call site is reachable from an unencrypted
  artifact -- egress candidates are selected by encrypted extension only
  (INV-BACKUP-002).
- The new raw SQL in the dispatcher and reaper is column-checked against
  `database/schema.sql` by the existing `raw-sql-columns.spec.ts` (name the new
  table's columns correctly).

## Rollout order and deployment safety

1. WP1 (digest) and WP2 (uploader) are neutral and can land first; nothing uses
   them yet.
2. WP3 introduces the table and the dispatch but ships **off by default**
   (`BACKUP_OFFSITE_PROVIDER` unset). A deployment turns it on only after
   provisioning an append-only bucket and a PutObject-only token.
3. Enable in staging against MinIO first; confirm `uploaded` states and that the
   token genuinely cannot delete (attempt a delete with it and observe the deny).
4. Stage 2 (retry) and Stage 3 (email) are additive and independently
   deferrable.

Migrations already merged to `main` are never edited; the new table is a new
migration with `schema.sql` updated in the same commit.

## Open questions

- **Interaction with `BACKUP_STORAGE_PROVIDER=s3`** (horizontal-scaling S2): when
  the primary store is already S3, does the off-machine copy no-op, or copy to a
  *second* bucket/region for true off-site separation? Resolve before WP3 if S2
  is in flight.
- **Per-user vs deployment destination.** One bucket for the whole deployment
  (keys carry `userId`, as specced) versus a bucket per user. The spec assumes
  one bucket; a multi-tenant operator may want isolation. Decide before WP3.
- **Email: attach vs link** (Stage 3). Artifacts are tens of MiB; SMTP ceilings
  are ~10-25 MB. Options: attach only when under `BACKUP_EMAIL_MAX_BYTES`, else a
  link to the S3 object (requires a read-capable presign, which reintroduces a
  read credential this feature otherwise avoids); or always link. Unresolved.
- **Retention visibility.** The app cannot delete off-machine copies, so the admin
  surface cannot show "N kept". Should it surface the operator's configured
  lifecycle policy read-only, or say nothing? Leaning: say nothing, document that
  retention is the bucket's.
- **Digest column reuse.** WP1's egress digest is close to a general artifact
  content hash `INV-BACKUP-001`'s restore path could also use. Keep it egress-only
  for now, or store it on the local artifact's own record? Decide in WP1 review.
