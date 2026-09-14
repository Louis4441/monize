# Spec: ship backups off the machine (S3 append-only, then email)

Approved specification for copying an automatic backup off the container it was
written on, so the loss of the backup volume is not the loss of every backup.
Written before the implementation, per `docs/financial-calculation-contract.md`
section 7 and `AGENTS.md` ("a financial feature of any substance starts from a
short approved spec"). The staged plan and its task graph are
`docs/future-plans/backup-off-machine.md` and its `-tasks.md`.

This spec governs the invariants of the off-machine copy. It is stage-first: the
invariants in section 4 hold from the first stage (S3 append-only) and are
restated, not loosened, when email is added. The ordering and verification rules
it builds on are `EXT-001`..`EXT-004` in `docs/external-side-effects.md`; the
completeness rule it builds on is `INV-BACKUP-001`.

## 1. What this adds

An automatic backup today lands only on the local backup volume
(`BACKUP_CONTAINER_DIR`, per user, sharded). The container is ephemeral; if the
volume is lost, so is every recovery point. This feature adds, **after** a
complete local artifact exists, a copy of that same artifact to an off-machine
destination:

- **Stage 1 -- S3 (append-only).** Upload the artifact to an S3-compatible bucket
  with a credential and an app-side write mode that can add a new object but can
  neither overwrite nor delete one.
- **Stage 2 -- retry and lifecycle.** Durable per-artifact upload state so a
  transient failure is retried rather than lost.
- **Stage 3 -- email.** Deliver a size-bounded, encrypted artifact (or a link to
  one) to a configured address.

The copy is a *copy*. The local artifact remains the primary, is written first,
and is what restore reads. Nothing in this feature changes the on-disk format,
the export pipeline, retention, or restore.

## 2. The behaviour this replaces

There is no off-machine delivery of a backup anywhere in `backend/src` today. The
only "leaves the machine" artifact is the support backup, which is
unconditionally encrypted precisely because it exists to leave the user's machine
(`docs/backup-restore-contract.md` section 9). The only email that mentions a
backup is failure *alerting* (`BACKUP_FAILED` / `BACKUP_PARTIAL` system alerts),
never delivery. This feature is the first backup egress path, so it is the first
place the egress invariants below have to be stated and enforced.

## 3. Definitions

- **Artifact.** One written backup file: `monize-backup-<tier>-<date>.<ext>`,
  `ext` one of `mzbe` (encrypted) or `json.gz` (unencrypted), per
  `backend/src/backup/backup-file-names.ts`.
- **Complete artifact.** One whose `completeness.complete` is true, published
  under a `daily`/`weekly`/`monthly` tier (never `partial`), per
  `INV-BACKUP-001`. Only a complete artifact is a candidate for egress.
- **Off-machine copy.** The bytes of an artifact placed on a destination that
  does not share the backup container's lifecycle: an S3 object (Stage 1) or an
  email (Stage 3).
- **Append-only destination.** A destination the application can add a new object
  to but cannot overwrite or delete an existing one -- enforced on two
  independent layers (section 4, `INV-BACKUP-004`).
- **Egress digest.** The SHA-256 of the exact artifact bytes as written locally.
  It is the identity the destination is asked to verify and the value durable
  state records.

## 4. Invariants

Each is proposed for `docs/system-invariants.md` (and the matching row in
`docs/verification-contract.md` section 3) by the implementation PR that first
enforces it. They are listed here as the contract the implementation must meet.

### INV-BACKUP-002 -- an artifact is encrypted before it leaves the machine

```text
Statement           Only an encrypted (.mzbe) artifact is ever copied off the
                    machine. An unencrypted (.json.gz) artifact is refused for
                    egress, not shipped in clear.
Source of truth     The artifact's own extension / envelope magic
                    (backup-envelope.ts "MZBE"); the egress dispatcher reads it.
Enforcement         The dispatcher selects candidates by encrypted extension and
                    refuses any other; a source-scanning guard asserts no egress
                    path is reachable from an unencrypted artifact. Mirrors the
                    support-backup rule (a payload that leaves the machine is
                    unconditionally encrypted, docs/backup-restore-contract.md
                    section 9).
Concurrency scope   per artifact
Failure response    The copy is skipped and an admin alert is raised naming the
                    user whose deployment has no usable backup password, so the
                    off-machine copy is understood to be absent rather than
                    silently unencrypted. The local artifact is unaffected.
Required tests      Unit: a .json.gz artifact is never handed to the uploader; a
                    .mzbe artifact is. Guard: egress is unreachable from a
                    plaintext artifact.
Status              unenforced (spec only; no egress path exists yet)
```

The artifact carries third-party API keys **in the clear** inside its data (they
are decrypted into `api_key_plaintext` for the export). That is why an
unencrypted artifact must never leave the machine, and why this is an invariant
rather than a preference. A deployment with no `ENCRYPTION_KEY`, or a user with
no usable backup password, produces `.json.gz` artifacts; for those the correct
off-machine state is *no copy plus a visible alert*, never a plaintext upload.

### INV-BACKUP-003 -- a local copy exists and is complete before any off-machine copy

```text
Statement           No off-machine copy is attempted until the local artifact is
                    completely written (renamed to its final name) and recorded
                    as complete. The off-machine copy never precedes, replaces, or
                    can delete the local one.
Source of truth     The local artifact on disk + lastBackupStatus.
Enforcement         Egress is dispatched from the tail of a successful backup
                    run, after applyBackupOutcome, outside the export
                    transaction (the push-after-commit shape,
                    docs/external-side-effects.md section 4a). A partial artifact
                    is never a candidate.
Concurrency scope   per artifact, per user
Crash semantics     A crash before the local rename leaves no candidate and no
                    copy -- the survivable direction. A crash after the local
                    write but before the copy leaves the local artifact intact and
                    the copy pending (Stage 2 retries it; Stage 1 records it
                    failed).
Failure response    An egress failure never fails the local backup; it is recorded
                    as its own off-site status.
Required tests      Unit: dispatch runs only on report.complete and only after the
                    outcome write; an upload throw does not change
                    lastBackupStatus from success.
Status              unenforced (spec only)
```

### INV-BACKUP-004 -- the application cannot delete or overwrite an off-machine copy

```text
Statement           The credential and the code path used for egress can add a
                    new object but cannot delete or overwrite an existing one.
                    Retention of off-machine copies is the operator's, via bucket
                    lifecycle / object-lock policy, never the application's.
Source of truth     The IAM policy on the token (operator) AND the code (no
                    DeleteObject, conditional PutObject).
Enforcement         Two independent layers. (1) Operator: the documented token
                    grants s3:PutObject only, on a versioned, object-locked bucket
                    -- no s3:DeleteObject, no overwrite. (2) Application: the
                    off-site uploader is a distinct provider that never
                    constructs a DeleteObjectCommand and issues PutObject with an
                    "object must not already exist" precondition (IfNoneMatch:
                    "*"), so even a mis-scoped token cannot clobber an existing
                    key. A source-scanning guard asserts the off-site uploader
                    imports no delete/overwrite command.
Concurrency scope   deployment (one bucket) / per object (one key)
Failure response    A precondition failure (key already exists) is reconciled by
                    digest, not overwritten -- see the truth table, section 5.
Required tests      Guard: off-site uploader has no DeleteObjectCommand import and
                    no unconditional overwrite. Unit: an existing key is not
                    overwritten.
Status              unenforced (spec only)
```

The existing `S3StorageProvider`
(`backend/src/attachments/storage/s3-storage.provider.ts`) implements
`save`/`load`/`delete` and imports `DeleteObjectCommand`; it is therefore **not**
the egress path. The egress uploader reuses that file's transport concerns only
-- lazy client construction, the aborting total deadline (`withDeadline`), and
`assertSafeStorageKey` from `storage-key.util.ts` -- extracted so both share one
implementation, and adds none of its mutation surface.

### INV-BACKUP-005 -- an off-machine copy is verified before it is recorded as done

```text
Statement           An off-machine copy is reported "uploaded" only after the
                    destination has verified it received the exact bytes (by
                    egress digest), not after the call returned. An unverifiable
                    copy is recorded in a form that says so.
Source of truth     Durable off-site upload state keyed on (user, artifact),
                    carrying the egress digest and the verified outcome.
Enforcement         PutObject sends the SHA-256 as x-amz-checksum-sha256 so S3
                    validates it server-side and rejects a mismatch; the state
                    row moves to "uploaded" only on a 200 that carries back the
                    matching checksum. EXT-002 / EXT-003.
Concurrency scope   per artifact
Crash semantics     A crash between the verified put and the state write leaves
                    the row "pending"/"uploading"; a re-run re-puts under the same
                    key (idempotent by digest, section 5) rather than duplicating.
Retry semantics     A transient failure leaves "failed" with the digest recorded;
                    Stage 2's retry re-attempts the same bytes under the same key.
Failure response    "failed" is a durable, findable state, not a silent success.
Required tests      Two-connection / integration where the property is a real S3
                    round-trip (test bucket or MinIO): a corrupted body is
                    rejected; a re-run of an already-uploaded artifact is a no-op.
Status              unenforced (spec only)
```

## 5. Truth table -- when a copy is attempted and recorded

`local` = local artifact state; `enc` = encrypted?; `dest key` = whether the
destination already holds this artifact's key; the last two columns are the
action and the durable off-site status.

| local | enc (.mzbe) | dest key state | Action | Off-site status |
| --- | --- | --- | --- | --- |
| partial / failed | any | -- | no candidate | (none) |
| complete | no (.json.gz) | -- | refuse egress, alert | `skipped-unencrypted` |
| complete | yes | absent | PutObject with digest + IfNoneMatch | `uploaded` on verified 200 |
| complete | yes | present, same digest | treat as done, no overwrite | `uploaded` (idempotent) |
| complete | yes | present, different digest | do **not** overwrite; alert | `conflict` |
| complete | yes | transient error (timeout, 5xx) | leave for retry | `failed` (Stage 1) / `pending-retry` (Stage 2) |

The "present, different digest" row is the append-only invariant meeting reality:
two different artifacts must never share a key (section 6 makes the key carry the
date and a disambiguator), so a same-key/different-digest collision is an anomaly
to surface, never to resolve by overwriting.

## 6. Object key and idempotency (append-only)

An append-only destination cannot overwrite, so the key must be stable for the
same bytes and distinct for different bytes. The key is:

```text
<BACKUP_S3_PREFIX>/<ab>/<cd>/<userId>/monize-backup-<tier>-<date>-<digest12>.mzbe
```

where `<ab>/<cd>/<userId>` is the same `shardedSegments(userId)` layout the local
volume uses, and `<digest12>` is the first 12 hex chars of the egress digest.
Consequences:

- **Re-running the same complete artifact is a no-op**: same bytes -> same digest
  -> same key, and the `IfNoneMatch` put fails cleanly against the object already
  there; the digest matches, so it is recorded `uploaded` (idempotent, EXT-001 by
  natural key).
- **A same-day re-export that produced different bytes** (an attachment arrived
  between runs) lands under a *different* key and both are kept; append-only means
  the destination keeps every distinct recovery point and the operator's lifecycle
  policy ages them out. This is intentional and is why retention is not the
  application's here.

## 7. Missing data / failure policy

- **No `ENCRYPTION_KEY` / no usable backup password** -> artifact is `.json.gz`
  -> `skipped-unencrypted` + admin alert (INV-BACKUP-002). Never a plaintext
  upload.
- **Destination not configured** (`BACKUP_S3_BUCKET` unset while egress is on) ->
  boot-time refusal with an error naming the variable, the same shape
  `ATTACHMENT_S3_BUCKET` uses; egress off by default so an un-configured
  deployment is unaffected.
- **Destination unreachable / credentials wrong / timeout** -> `failed` with the
  digest recorded; local backup unaffected; Stage 1 leaves it for the next
  scheduled run to notice, Stage 2 retries under a claim.
- **Verification mismatch** -> the put is rejected by S3 (checksum) and never
  recorded `uploaded`; treated as `failed`.
- **Bucket returns "key exists" with a different digest** -> `conflict` + alert,
  never overwrite (section 5).

Every non-success terminal state is durable and attributable to the user and the
artifact, per EXT-003.

## 8. Numerical / worked examples

1. **Encrypted daily, first upload.** User A, `daily` tier, `2026-09-14`,
   artifact bytes hash to `9f3c...`; key ends `-9f3c1a2b4d5e.mzbe`. PutObject with
   `x-amz-checksum-sha256` = the full digest, `IfNoneMatch: *`. S3 returns 200 and
   echoes the checksum. State -> `uploaded`, digest `9f3c...`.
2. **Cron re-fires on the same complete artifact.** Same bytes, same key.
   `IfNoneMatch` put fails `412 PreconditionFailed`. Recorded digest already
   equals `9f3c...`, so the copy is already present and correct -> `uploaded`
   (no-op). No second object, no overwrite.
3. **Same-day re-export after an attachment landed.** New bytes hash `71aa...`;
   key ends `-71aa9c0d1e2f.mzbe` -- a different object. Both `9f3c...` and
   `71aa...` exist off-machine; the operator's lifecycle rule decides when the
   older ages out. Neither the app nor this run deletes anything.
4. **Plaintext deployment.** No `ENCRYPTION_KEY`; artifact is
   `monize-backup-daily-2026-09-14.json.gz`. Not a candidate. State
   `skipped-unencrypted`; `BACKUP_PARTIAL`-class admin alert says the off-machine
   copy was withheld because the artifact is unencrypted.
5. **Transient S3 outage.** PutObject aborts on the deadline. Local artifact
   intact, `lastBackupStatus` still `success`. Off-site state `failed` with digest
   `9f3c...`. Stage 2's reaper re-attempts under the same key; step 2's
   idempotency makes a late-landing first attempt safe.

## 9. Shape (durable state)

Off-site upload state is per (user, artifact-key), so a retry finds exactly what
it must re-attempt. Indicative shape (the migration is the implementation's):

```text
backup_offsite_uploads
  user_id        uuid    -- owner (RLS-scoped)
  object_key     text    -- the full destination key (carries date + digest)
  tier           text    -- daily | weekly | monthly
  digest         char(64)-- egress digest (SHA-256 hex)
  size_bytes     bigint
  status         text    -- pending | uploading | uploaded | failed
                         --   | conflict | skipped-unencrypted
  attempts       int
  last_error     text
  created_at, updated_at
  UNIQUE (user_id, object_key)   -- one row per artifact per destination key
```

The LLM/reporting surfaces do not read this; it is operator state, exposed (Stage
1) as a per-user off-site status on the existing admin backup surface.

## 10. Test matrix

| Property | Invariant | Test kind | Where |
| --- | --- | --- | --- |
| A plaintext artifact is never uploaded | INV-BACKUP-002 | unit + source-scan guard | `auto-backup`/egress spec; a `*.guard.spec.ts` |
| Egress runs only after a complete local write | INV-BACKUP-003 | unit | egress dispatch spec |
| An upload throw does not change `lastBackupStatus` | INV-BACKUP-003 | unit | `auto-backup.service.spec.ts` |
| Off-site uploader constructs no delete/overwrite | INV-BACKUP-004 | source-scan guard | a `*.guard.spec.ts` |
| An existing key is not overwritten | INV-BACKUP-004 | unit | egress uploader spec |
| A corrupted body is rejected by the destination | INV-BACKUP-005 | integration (MinIO/test bucket) | new integration spec |
| A re-run of an uploaded artifact is a no-op | INV-BACKUP-005 | integration | new integration spec |
| `failed` is durable and carries the digest | INV-BACKUP-005 | integration | new integration spec |

A green suite through any of these behaviours is a finding, per `AGENTS.md`; the
verification kind for each is fixed by `docs/verification-contract.md` (a real
S3-compatible round-trip, not a mocked client, for the INV-BACKUP-005 rows).

## 11. Out of scope

- Whole-instance disaster recovery (a separate backup of PostgreSQL and the
  attachment store) -- explicitly out of this feature per
  `docs/backup-restore-contract.md`.
- Replacing the local backup store with S3 (that is the `BACKUP_STORAGE_PROVIDER`
  idea in `docs/future-plans/horizontal-scaling.md`, task S2 -- a *different*
  change; see the plan's "Relationship to the horizontal-scaling plan").
- Restoring directly from an off-machine copy; restore continues to read the
  local artifact. An operator recovering from S3 first copies the object back onto
  the backup volume.
- Off-machine copies of manual or support backups; this feature copies automatic
  backups only.
