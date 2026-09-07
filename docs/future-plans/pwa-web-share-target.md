# Web Share Target: sharing files into the installed Monize PWA

Status: PROPOSED (spec-first, per root `CLAUDE.md`: a feature of any substance
starts from a short approved spec committed before the implementation).
Related: discussion #1292 (second part), INV-ATTACHMENT-001, INV-IMPORT-001..003.

The first part of #1292 (document scanning and image enhancement) is a separate
plan and is not covered here. This document is the plan for the second part:
making an installed Monize PWA appear in the operating system's Share sheet so a
user can send a receipt photo, a PDF, or a bank statement export (CSV, OFX, QFX,
QIF) straight to Monize, land on an explicit review screen, and then hand the
files to the same transaction form or import wizard they would reach through the
file picker.

---

## 1. Requirements (from #1292 and the maintainer's constraints)

R1. Monize appears in the Share sheet of an installed PWA on platforms that
    support the `share_target` manifest member (Android Chrome and other
    Chromium browsers; desktop Chromium's installed apps). It appears only for
    file shares Monize can actually use.

R2. A share always lands on an **explicit review screen**. Nothing is imported,
    attached or saved without the user pressing the button that does it. The
    existing validation workflows (transaction form save, import wizard review
    step) are the doors the files go through; the share target opens no new one.

R3. Only an **authenticated user** reaches the files. A share that arrives while
    logged out is held on the device, and offered again after login.

R4. **Upload limits are enforced** before any byte reaches the server, and the
    server's own limits are unchanged and still apply.

R5. **Progressive enhancement.** iOS Safari does not support `share_target`;
    browsers without a controlling service worker cannot receive the POST. Both
    keep the existing file-picker flows; neither sees an error page.

R6. No new persistent server-side surface: the server never stores shared
    bytes on behalf of the share target, and the endpoints the review screen
    calls are the ones that exist today.

Non-goals for this plan: text-only or URL-only shares (Section 3.4), Microsoft
Money `.mny` files (Section 3.3), and the scanning pipeline from the first part
of #1292.

---

## 2. How a share reaches the app (mechanism)

The Web Share Target API delivers files as a **browser-initiated multipart POST
navigation** to the manifest's `share_target.action` URL. There is no page and
no JavaScript running at that moment; the only code that can see the request
before the server does is the service worker.

```text
OS share sheet
  -> POST /share-target  (multipart/form-data, mode: navigate)
  -> sw.js fetch handler intercepts: reads formData, stashes each file in the
     Cache API under a synthetic key, responds 303 See Other -> /share?id=<uuid>
  -> GET /share?id=<uuid>  (ordinary protected page)
     -> proxy.ts: no session cookie -> 307 /login?returnTo=/share?id=<uuid>
     -> ProtectedRoute + the review screen read the stash, render the files,
        offer destinations
  -> user picks a destination
     -> New transaction: TransactionForm with the files staged, saved through
        POST /transactions then POST /transactions/:id/attachments (existing)
     -> Import: /import?share=<uuid>, the wizard's existing hand-off, the
        existing parse/review/import steps
```

Design decisions, each with the alternative rejected:

- **Service worker stash, not a server round trip.** The alternative is a Next
  route handler that receives the POST and holds the bytes (in memory, on disk,
  or in a new table) until the user is authenticated and has reviewed them.
  That is a new persistence surface for unauthenticated, unvalidated bytes, and
  it contradicts R6. The Cache API stash is same-origin storage on the device
  the file was already on, readable only by this origin, and the browser's
  documented pattern for file share targets.
- **Cache API, not IndexedDB.** The worker already owns one cache and one
  synthetic-key convention (`OFFLINE_STRINGS_URL`); the window can read the same
  cache with `caches.open`, so no `postMessage` protocol is needed to move the
  bytes from worker to page. IndexedDB would add a schema and a second storage
  API for no gain.
- **303, not 302 or 307.** A 303 turns the POST into a GET so the redirect
  target is an ordinary page load. A 307 would replay the POST against `/share`
  and a 302 is ambiguous across browsers.
- **The action path and the page path differ** (`/share-target` and `/share`),
  because a Next segment cannot host both a `page.tsx` and a `route.ts`, and
  because the page must be reachable by plain GET without any worker involved
  (the "share arrived while logged out" resume, Section 4.3).

### 2.1 When the worker is not controlling (R5)

A share target is only offered for an installed PWA, and the worker registers on
the first load, so the POST normally never reaches the network. When it does
(worker evicted, a browser that installs without registering), the request
reaches `proxy.ts`. The proxy answers `POST /share-target` with a 303 to
`/share?missed=1` **before** its auth check and **without reading the body**,
so an unauthenticated share does not become a 307 that replays a multipart POST
against `/login`. The review screen explains that the files were not received
and to open Monize once and share again; the picker flows are one tap away.

The claim "the server never receives the bytes on the worker path" is a
property of the worker intercepting a navigation; the claim "the server never
*stores* them on the fallback path" is a property of the proxy discarding the
body, held by a source scan (Section 7).

---

## 3. What Monize accepts

### 3.1 Manifest

`buildManifest` (`frontend/src/lib/pwa-manifest.ts`) gains a `share_target`
member. The manifest URL varies with the theme query string; `share_target` is
theme-independent and `id: '/'` already pins every variant to one app.

```json
"share_target": {
  "action": "/share-target",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": {
    "files": [
      { "name": "files", "accept": ["<SHARE_TARGET_ACCEPT>"] }
    ]
  }
}
```

`SHARE_TARGET_ACCEPT` is **derived**, never restated: the attachment set
(`ACCEPTED_ATTACHMENT_TYPES` in `frontend/src/types/attachment.ts`, which
mirrors `ALLOWED_ATTACHMENT_MIME_TYPES` on the backend) plus one explicit
statement extension list, `SHARE_STATEMENT_EXTENSIONS` (`.csv`, `.ofx`,
`.qfx`, `.qif`), and their common MIME spellings (`text/csv`,
`application/x-ofx`, `application/vnd.intu.qfx`, `application/qif`,
`application/x-qif`). Both extension and MIME entries are listed, for the same
reason `ATTACHMENT_ACCEPT` in `lib/ai-attachments.ts` lists both: Android
matches the share sheet on the shared item's MIME, and a statement exported
from a bank app is frequently `application/octet-stream` with only the
extension to go on. A test derives the expected list from the two source
constants and fails when either changes without the manifest following.

### 3.2 Limits (R4)

The worker enforces limits on arrival. A file over a limit is recorded in the
bundle index with a reason and **its bytes are not stored**; the review screen
shows it greyed with the reason, so a rejected share is explained rather than
silently shrunk.

| Limit | Value | Derived from |
| --- | --- | --- |
| Per-file bytes | 10 MB | `MAX_ATTACHMENT_BYTES` (attachments) and the 10 MB JSON body limit in `backend/src/main.ts` that the statement parse endpoints sit behind (their content travels as a JSON string) |
| Files per share | 10 | `MAX_ATTACHMENTS_PER_TRANSACTION` |
| Bytes per share | 50 MB | bounds the stash on a device; a bank export never approaches it |
| Stash lifetime | 1 hour | long enough to log in and come back; short enough that a statement is not left on a shared device (Section 4.4) |

The worker cannot import from the app, so `sw.js` carries these as literals
beside `OFFLINE_COLORS`, and `src/test/sw-share-target.test.ts` asserts them
against the exported constants in `lib/share-target.ts` -- the same mirroring
discipline `sw-offline.test.ts` applies to the boot palette.

The server side does not change: `AttachmentsService.create` still sniffs the
magic bytes and refuses SVG, oversize and over-count; the import endpoints still
parse and validate. The worker's limits are a courtesy to the user and a bound
on device storage, not the authority.

### 3.3 What is deliberately outside the accept list

- `.mny`. A Money file is a whole profile, hundreds of megabytes, imported once
  through a wizard with a password prompt and a wipe confirmation. Offering it
  in a share sheet invites an accidental profile import from a phone; the picker
  flow stays the only door.
- SVG, archives, Office documents: not attachable today; the accept list must
  not promise what the server refuses.

### 3.4 Text and URL shares

The manifest declares no `title`, `text` or `url` params. Declaring them makes
Monize appear for every text share on the device, and a plain text share has no
destination in Monize that is not a guess (payee? description? memo?). If a
later plan gives text a home (a note on a transaction, an AI assistant prompt),
it adds the params and a text destination on the review screen together.

---

## 4. The review screen and the hand-offs (R2, R3)

### 4.1 Route and reading the stash

A new `share` route segment under frontend/src/app (its page, wrapped in
`ProtectedRoute` like every other page), reads `id` from the query and asks `lib/share-inbox.ts` for the bundle.
That module is the only code that names the cache and the synthetic key shape:

- `listSharedBundles()` -- indexes of every bundle still in the stash;
- `readSharedBundle(id)` -- index plus one `File` per accepted entry, rebuilt
  from the cached `Response` (filename and type ride as headers the worker set);
- `discardSharedBundle(id)` -- removes the bundle;
- `purgeExpiredSharedBundles()` -- removes anything past the lifetime;
- `clearShareInbox()` -- removes the cache, called from `authStore.logout`
  beside `clearAllCache()`.

Every function feature-detects `window.caches` and treats its absence as an
empty inbox; the page then shows the unsupported explanation (R5), never a
crash.

### 4.2 Destinations

The bundle's accepted files decide which destinations are offered. Files are
classified by one rule in `lib/share-target.ts`: attachment-type if the MIME
is in `ACCEPTED_ATTACHMENT_TYPES`, statement-type if the extension is in
`SHARE_STATEMENT_EXTENSIONS`. The wizard's own `detectFileType` is deliberately
not the classifier: it falls through to QIF for any extension it does not
know, which is right for a picker (the user chose the file) and wrong for a
share sheet (the OS chose it against the accept list, and anything else must
be refused with a reason, not parsed as QIF).

| Bundle | Offered |
| --- | --- |
| All attachment-type | New transaction (files staged); Ask the assistant (Phase 2) |
| All statement-type | Import |
| Mixed | Neither; the screen says to share receipts and statements separately, and offers Discard |
| Nothing accepted | The per-file reasons, and Discard |

Every destination is a button the user presses. There is no auto-advance, even
for a single-file bundle: the review screen is the point of R2.

**New transaction.** The page hosts `Modal` + `TransactionForm` the way
`CategoryTransactionsTab` and `SecurityTransactionHistory` already do.
`TransactionForm` gains `initialStagedFiles?: File[]`, seeding the
`stagedAttachments` state it already keeps for the unsaved-transaction case;
the form's existing post-create upload loop then sends each file through
`attachmentsApi.upload`. On success the bundle is discarded and the page routes
to the new transaction's register.

**Import.** The page routes to `/import?share=<id>`. `useImportWizard`'s
`handleFileSelect(e)` is split: the body becomes `handleFiles(files: File[])`,
and the change handler becomes a two-line adapter. The import page reads the
`share` query once (a ref guards the effect; `useSearchParams` sits under
`Suspense` as Next requires), reads the bundle, calls `handleFiles`, and
discards the bundle once the wizard has taken the contents. From there the
wizard is unchanged: headers, mapping, review, and only then import.

**Attach to an existing transaction** is Phase 2 (Section 8): it needs a
transaction picker the codebase does not have, and building one to a plan of
its own is better than a search box improvised here.

### 4.3 A share that arrives while logged out

The worker stashes and redirects regardless of session; `proxy.ts` sends the
GET to `/login?returnTo=/share?id=<uuid>` (the login page's existing
`safeReturnTo` accepts a same-origin path), and login lands back on the review
screen. Two things make this hold when `returnTo` is lost (an OIDC round trip
that drops it, a user who opens the app from the launcher instead):

- The proxy's unauthenticated redirect carries `returnTo` for this path. Today
  it redirects to a bare `/login`; the change is scoped to `/share` so no other
  page's behaviour moves in this plan.
- `ShareInboxNotice`, mounted in the app shell beside `OfflineFallbackSync`,
  calls `purgeExpiredSharedBundles()` then `listSharedBundles()` on mount and
  shows a dismissible banner ("2 files were shared with Monize -- review them")
  linking to `/share?id=`. A stash the user never reaches is still purged by
  its lifetime.

### 4.4 Lifetime and privacy of the stash

A bundle is deleted when consumed, when discarded, when the user logs out, and
when it is older than the lifetime. The worker purges expired bundles on
`activate` and on every new share, so the bound holds even if no page runs. The
worker's `activate` handler currently deletes every cache but `CACHE_NAME`; the
share cache must be added to its keep-list, or the first worker update after a
share silently empties the inbox (Section 7 has the test).

The stash never holds a file the worker rejected, and it never holds the
multipart framing: each accepted file is one `Response` whose body is the file's
bytes and whose headers carry the URL-encoded filename, the declared type and
the size. The filename is rendered through React, and the synthetic keys carry
no extension, so `isStaticAsset` can never serve a stash entry to a fetch.

---

## 5. Invariants

| ID | Statement | Mechanism |
| --- | --- | --- |
| INV-SHARE-001 | A shared file reaches the server only through an endpoint that exists today, under the same authentication, CSRF, sniffing and size rules as a picked file. | No new backend route; the review screen calls `attachmentsApi.upload` and the import wizard's existing API. `proxy.ts` answers the share POST with a redirect and never reads its body (source scan). |
| INV-SHARE-002 | Nothing is imported, attached or saved from a share without an explicit user action on a screen that shows what will happen. | The review screen has no auto-advance; the two destinations are the existing form save and the wizard's review step. E2E asserts that landing on `/share` creates no rows. |
| INV-SHARE-003 | The stash holds only files within the declared limits, and no bundle outlives its lifetime or the session. | Worker-side limit checks store a reason, not bytes; purge on `activate`, on each share, on app mount; `clearShareInbox()` in `logout`. |
| INV-SHARE-004 | A share never produces an error page: on every path the user lands on a Monize page that explains what happened. | The worker's handler always resolves to a redirect (malformed body -> `/share?error=stash`); the proxy fallback redirects; the review screen has states for missed, unsupported, expired, empty. |

These are added to `docs/system-invariants.md` with the plan, as `unenforced`
until the implementation lands, in keeping with that document's rule that
editing it does not close a gap.

---

## 6. Files

New:

- `frontend/src/lib/share-target.ts` -- `SHARE_TARGET_PATH`, `SHARE_PAGE_PATH`,
  `SHARE_TARGET_ACCEPT` (derived), the limit constants, the cache name and key
  helpers shared by the page and the tests.
- `frontend/src/lib/share-inbox.ts` -- the window-side reader (Section 4.1).
- a new `share` route segment under frontend/src/app -- the review screen and
  its test.
- `frontend/src/components/share/` -- `SharedFileList`, `ShareDestinations`,
  `ShareInboxNotice`.
- `frontend/src/i18n/messages/en/share.json` (registered in
  `src/i18n/messages.ts`), pseudo-locale regenerated.
- `frontend/src/test/sw-share-target.test.ts`.
- `e2e/tests/share-target.spec.ts`.

Changed:

- `frontend/public/sw.js` -- share POST branch in `fetch`, the stash helpers,
  the keep-list in `activate`, the purge.
- `frontend/src/lib/pwa-manifest.ts` and its test.
- `frontend/src/proxy.ts` and `proxy.test.ts` -- the fallback redirect and the
  `returnTo` on `/share`.
- `frontend/src/hooks/useImportWizard.ts` -- `handleFiles` extracted;
  `frontend/src/app/import/page.tsx` reads the `share` query.
- `frontend/src/components/transactions/TransactionForm.tsx` --
  `initialStagedFiles`.
- `frontend/src/store/authStore.ts` -- `clearShareInbox()` on logout.
- `frontend/src/app/layout.tsx` -- mounts `ShareInboxNotice`.
- `docs/system-invariants.md`, `docs/external-side-effects.md` (the stash is a
  client-side store; a short entry says it is not the server's and what bounds
  it), `frontend/CLAUDE.md` (a paragraph naming `lib/share-inbox.ts` as the one
  reader of the stash and `lib/share-target.ts` as the one accept list).

No backend or database change. No Helm or Docker change: the manifest and the
worker are already served by the frontend container.

---

## 7. Test matrix

| Claim | Kind | Where |
| --- | --- | --- |
| `share_target` shape; accept list equals the derivation from the two source constants | Unit | `pwa-manifest.test.ts` |
| Worker literals equal `lib/share-target.ts` constants | Unit, mirror check | `sw-share-target.test.ts` |
| POST to the action stashes each file and answers 303 to `/share?id=` | Unit, vm harness (the `sw-push.test.ts` pattern, with `caches`, `crypto.randomUUID` and `Response.redirect` stubbed) | same |
| Oversize file: reason stored, no bytes; over-count: the rest rejected with reason; total bound | Unit | same |
| GET to the action, POST elsewhere, and a page `fetch` POST to another path are not intercepted | Unit | same, extending the existing "leaves other requests to the network" case |
| Malformed multipart still resolves to a redirect | Unit | same |
| `activate` keeps the share cache; purge removes only expired bundles | Unit | same |
| `share-inbox.ts` rebuilds a `File` with name and type; absent `caches` is an empty inbox; expired purge | Unit | `share-inbox.test.ts` |
| Review screen states: bundle, mixed, none accepted, missed, unsupported, expired | Unit | the share page's own test beside it |
| `handleFiles` accepts a `File[]` and the change handler delegates to it | Unit | `useImportWizard.test.tsx` |
| `initialStagedFiles` seeds the staged list and is uploaded after create | Unit | `TransactionForm.test.tsx` |
| Proxy: `POST /share-target` -> 303 `/share?missed=1` with no session; the proxy source never reads that request's body | Unit + source scan | `proxy.test.ts` |
| Unauthenticated `GET /share?id=x` -> `/login?returnTo=` carrying the path | Unit | `proxy.test.ts` |
| Logout clears the inbox | Unit | `authStore.test.ts` |
| A statement shared end-to-end lands on the wizard's mapping step and creates nothing until Import is pressed; a receipt shared end-to-end lands on the form and creates the attachment only on save | E2E, Chromium (the test posts a `FormData` to the action from the page, follows the 303, and drives the review screen; the OS share sheet itself cannot be scripted) | `e2e/tests/share-target.spec.ts` |
| i18n parity and pseudo-locale freshness | Existing suites | `messages.parity.test.ts`, `i18n:check` |

A green run of the existing suites after adding the worker branch would be a
finding: the only existing worker `fetch` test asserts non-interception of a
GET, so the new branch needs its own cases from the first commit.

---

## 8. Phasing

**Phase 1 (this plan's deliverable):** manifest, worker stash, proxy fallback,
review screen, the New transaction and Import destinations, the logged-out
resume, the lifetime and logout purge, the tests above, English catalog plus
pseudo-locale during development and the full translation pass as the final
commit.

**Phase 2 (separate plan):** attach to an existing transaction (a transaction
picker), and Ask the assistant (hand the files to `ChatInterface` as
`ChatAttachment`s, which already accepts images, PDF and CSV under its own
5 MB / 20 MB caps -- the classification table gains a column and nothing else
moves).

**Phase 3, if the first part of #1292 ships:** the scan pipeline runs on the
review screen before the New transaction destination, with the original
preserved as that plan requires.

---

## 9. Open questions for the maintainer

1. Stash lifetime: one hour is proposed. A shorter value protects a shared
   device; a longer one tolerates a slow OIDC login. Say if either matters more.
2. Whether the review screen should offer Import for a single CSV that could
   equally be an investment CSV (the wizard already disambiguates on its
   mapping step, so the proposal is to let it).
3. Whether desktop Chromium's installed-app share target is worth a line in the
   README, or whether the feature should be documented as Android only.
