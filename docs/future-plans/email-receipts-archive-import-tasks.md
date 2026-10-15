# Email receipts archive import: tasks

Plan: `email-receipts-archive-import.md`.

- [x] Backend: extract the receipt row builder and the insert from
      `EmailReceiptPollService` so the poll and the import share them; no
      behaviour change for the poll (its specs stay green unchanged).
- [x] Backend: mbox splitter and format detection (`.eml`, `.mbox`, `.msg`,
      `.zip`), with unit tests.
- [x] Backend: `EmailReceiptImportService` (uid derivation, `uid_validity = 0`,
      one transaction per file, the 5,000 cap) and `processStoredNow` on the
      poll service under the poll lease.
- [x] Backend: `POST /email-receipts/mailbox/import` (multer memory storage,
      20 files x 25 MB, translated 413, throttle 5/min); English and pseudo
      locale strings.
- [x] Frontend: `MailboxImportCard` in the Mailbox tab (upload, per-file
      result, the provider guide); API client and types; English and pseudo
      locale strings.
- [x] Backend: `.zip` (fflate, bounded by produced bytes) and `.msg`
      (@kenjiuno/msgreader, rebuilt as RFC 5322) readers, with unit tests
      including a lying-size zip and a msg with and without transport headers.
- [x] Frontend: accept `.zip` and `.msg`, show `ignoredEntries` and the new
      error codes; guide says a Takeout `.zip` and Outlook `.msg` upload as is.
- [x] Docs: `email-receipts.md` decision line, INV-RECEIPT-002 names the import
      path.
- [ ] Translate every other locale (final commit).
