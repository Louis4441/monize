# Monize wiki changes — encrypted backups and ENCRYPTION_KEY

**This directory is a staging copy, not documentation.** It holds edits to three
pages of https://github.com/kenlasko/monize/wiki, made alongside the code on
branch `claude/backup-encryption-password-auth-dphia1` (issue #1269) because the
wiki is a separate git repository that this repository's tooling cannot push to.

**Delete it once the pages are pushed to the wiki.** Two copies of the same page
is how one of them goes stale, and the wiki is the copy readers see.

## What is here

| File | What it is |
|---|---|
| `pages/Backup-and-Restore.md` | Full updated page — the biggest change |
| `pages/Getting-Started.md` | Full updated page — `ENCRYPTION_KEY` added to the required-settings block |
| `pages/Emergency-Access.md` | Full updated page — two mentions of `AI_ENCRYPTION_KEY` renamed |
| `wiki-changes.patch` | The same edits as two `git am`-able commits |
| `wiki-changes.diff` | The same edits as a plain diff, for review |

## Applying them

Either copy the three files over the wiki checkout:

    git clone https://github.com/kenlasko/monize.wiki.git
    cp docs/wiki-updates/pages/*.md monize.wiki/
    cd monize.wiki && git add -A && git commit && git push

Or apply the commits, which keeps the messages explaining each change:

    git clone https://github.com/kenlasko/monize.wiki.git
    cd monize.wiki
    git am ../monize/docs/wiki-updates/wiki-changes.patch
    git push

## What changed, in short

**Backup-and-Restore.md**

- Encryption is described as the default for password accounts, not an opt-in
  feature with an Enable/Disable pair. That stopped being true in 1.14, and the
  gap between this page and the UI is what issue #1269 was reported from.
- New section, linked from the intro: **Passwords, Keys, and What You Must Not
  Lose.** Two secrets, two jobs:
  - The password a backup was written with — a file opens with the password in
    effect *at the time it was written*, so changing a password strands older
    backups unless the old one is kept.
  - `ENCRYPTION_KEY` — the server's. Losing it costs stored API keys,
    emergency-access credentials, and automatic backups until each user signs in
    again; it does **not** lock anyone out of a backup file, because that file is
    encrypted with the user's password, not this key. That half is stated
    explicitly because it is the part people get wrong in both directions.
- The Settings section is described in its three real states, including the "Not
  enabled" one that a session older than the feature lands in, and the "Enable
  with My Login Password" button that fixes it.
- Manual backup steps corrected: the button is **Download Backup**, it prompts
  for the password, and the file is `.mzbe`.
- Tips and the Security table updated to match.

**Getting-Started.md**

- `ENCRYPTION_KEY` added to the minimum `.env`, alongside `JWT_SECRET`, with the
  distinction between them: the server refuses to start without `JWT_SECRET`,
  while `ENCRYPTION_KEY` is warned about on every boot today and will be required
  in a future release. Without it, automatic backups are written unencrypted.
- Notes that `AI_ENCRYPTION_KEY` is the former name and still accepted, so an
  existing deployment needs no changes — but that if it was never set, backups
  were and still are going out in the clear.

**Emergency-Access.md**

- Two references to the server key renamed to `ENCRYPTION_KEY`.
