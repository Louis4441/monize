import { readFileSync } from "fs";
import { join } from "path";

import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../../common/repo-tree.util";

/**
 * The append-only egress path, held mechanically (INV-BACKUP-004).
 *
 * The rule is that the application can add an object off-machine and can never
 * delete or replace one: retention off-machine is the operator's bucket
 * lifecycle policy, not ours. Two things have to stay true in the code for that
 * to mean anything, and both are the kind of thing a later edit does without
 * noticing.
 *
 * 1. **No delete and no read command reaches this directory.** The existing
 *    `S3StorageProvider` imports `DeleteObjectCommand`, which is exactly why the
 *    egress uploader is a separate class rather than a reuse of it; an import
 *    added here would undo that split silently. Reads are banned for a different
 *    reason: the credential operators are told to issue grants `s3:PutObject`
 *    and `s3:AbortMultipartUpload` and nothing else, so a `GetObject` or
 *    `HeadObject` in this path would be code that only works against a wider
 *    policy than the one documented -- and it would fail in production, on the
 *    deployment that followed the instructions.
 * 2. **Every completing write carries `IfNoneMatch`.** That is the second,
 *    independent layer: even a mis-scoped token cannot clobber an existing key,
 *    because the request itself refuses to. A `PutObjectCommand` or
 *    `CompleteMultipartUploadCommand` without it is an unconditional overwrite,
 *    whatever the surrounding comments say.
 *
 * The inventory comes from `git ls-files` (tracked and untracked-but-not-ignored
 * alike), not a hardcoded list, so a file split, a rename or a brand-new file in
 * this directory cannot disarm the scan -- the failure mode described in
 * `docs/backend/backup.md`, where four guards went on passing while scanning
 * code that had moved out from under them.
 *
 * Comments are blanked before matching, because this file's own prose names
 * every banned command and a raw-text scan would make the explanation fail the
 * guard. `docs/guard-tests.md` has the conventions; the stripper is tested in
 * both directions below.
 */

/** Commands that delete an object, or read one. Neither belongs on this path. */
const BANNED_COMMANDS = [
  "DeleteObjectCommand",
  "DeleteObjectsCommand",
  "GetObjectCommand",
  "HeadObjectCommand",
];

/** Constructions that publish an object, and so must be conditional. */
const COMPLETING_COMMANDS = [
  "PutObjectCommand",
  "CompleteMultipartUploadCommand",
];

const UPLOADER = "backend/src/backup/offsite/backup-offsite-s3.uploader.ts";

/**
 * Blank every comment body, preserving length and line breaks so an offender's
 * position still points at the right line. Strings, template literals and regex
 * literals are skipped so a `//` inside one is not read as a comment.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = "";
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      prev = c;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};+\n]/.test(prev || "\n")) {
      // A regex literal: `/` in an operand position rather than a division.
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/**
 * The argument text of every `<command>(...)` construction in `src`, matched by
 * paren depth so a nested object or call cannot end it early.
 */
export function constructionArguments(src: string, command: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`\\b${command}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src))) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push(src.slice(start, i + 1));
  }
  return found;
}

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("the off-site egress path is append-only (INV-BACKUP-004)", () => {
  const sources = (): { file: string; code: string }[] => {
    const root = requireRepoRoot(REPO_ROOT);
    return gitListFiles(
      root,
      "--cached --others --exclude-standard -- backend/src/backup/offsite",
    )
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .map((file) => ({
        file,
        code: blankComments(readFileSync(join(root, file), "utf8")),
      }));
  };

  it("scans the directory it claims to scan", () => {
    // Anti-vacuity: an inventory that found nothing would make every assertion
    // below pass while checking no code at all.
    const files = sources().map((source) => source.file);
    expect(files).toContain(UPLOADER);
  });

  it("constructs no delete or read command anywhere under offsite/", () => {
    const offenders = sources().flatMap(({ file, code }) =>
      BANNED_COMMANDS.filter((command) =>
        new RegExp(`\\b${command}\\b`).test(code),
      ).map(
        (command) =>
          `${file} names ${command}: the egress path may add an object and ` +
          `never delete, replace or read one (INV-BACKUP-004). The credential ` +
          `it runs under grants s3:PutObject and s3:AbortMultipartUpload only.`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("makes every completing write conditional", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const code = blankComments(readFileSync(join(root, UPLOADER), "utf8"));
    const constructions = COMPLETING_COMMANDS.flatMap((command) =>
      constructionArguments(code, command).map((args) => ({ command, args })),
    );
    // The marker this guard needs in order to be checking anything: a file that
    // stopped constructing either command would pass an empty list.
    expect(constructions.length).toBeGreaterThanOrEqual(
      COMPLETING_COMMANDS.length,
    );
    const offenders = constructions
      .filter(({ args }) => !args.includes("IfNoneMatch"))
      .map(
        ({ command }) =>
          `${UPLOADER} constructs ${command} without IfNoneMatch: an ` +
          `unconditional write can overwrite an off-machine copy ` +
          `(INV-BACKUP-004). Add IfNoneMatch: "*" to the same command input.`,
      );
    expect(offenders).toEqual([]);
  });

  it("points the uploader at the invariant it serves", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const uploader = readFileSync(join(root, UPLOADER), "utf8");
    expect(uploader).toContain("INV-BACKUP-004");
    expect(uploader).toContain("docs/specs/backup-off-machine.md");
  });
});

/**
 * The mechanism, in both directions. A scan that prose can trip is also a scan
 * that prose can satisfy, so each half is fed a fixture that must fail and one
 * that must pass.
 */
describe("the guard's own scanning", () => {
  it("blanks comments and leaves code, keeping line positions", () => {
    const src = [
      "// DeleteObjectCommand in a line comment",
      "/* DeleteObjectCommand in a block */",
      'const message = "DeleteObjectCommand in a string";',
      "const command = new PutObjectCommand({});",
    ].join("\n");
    const blanked = blankComments(src);
    expect(blanked.split("\n")).toHaveLength(4);
    expect(blanked).not.toMatch(/DeleteObjectCommand in a line/);
    expect(blanked).not.toMatch(/DeleteObjectCommand in a block/);
    expect(blanked).toContain("new PutObjectCommand({})");
  });

  it("does not read a comment marker inside a string or a regex", () => {
    const src = [
      'const url = "http://example.com/DeleteObjectCommand";',
      "const slashes = /^\\/+|\\/+$/g;",
      "const kept = HeadObjectCommand;",
    ].join("\n");
    const blanked = blankComments(src);
    // The string's contents are gone (it is a string, not code), but the scan
    // must not have swallowed the rest of the file as a comment.
    expect(blanked).toContain("const kept = HeadObjectCommand;");
  });

  it("finds a construction's arguments across nested parentheses", () => {
    const src =
      "send(new PutObjectCommand({ Key: key(prefix), Body: body }), options);";
    expect(constructionArguments(src, "PutObjectCommand")).toEqual([
      "({ Key: key(prefix), Body: body })",
    ]);
  });

  it("distinguishes a conditional write from an unconditional one", () => {
    const conditional =
      'new PutObjectCommand({ Key: k, Body: b, IfNoneMatch: "*" })';
    const unconditional = "new PutObjectCommand({ Key: k, Body: b })";
    expect(constructionArguments(conditional, "PutObjectCommand")[0]).toContain(
      "IfNoneMatch",
    );
    expect(
      constructionArguments(unconditional, "PutObjectCommand")[0],
    ).not.toContain("IfNoneMatch");
  });

  it("does not credit an IfNoneMatch that belongs to a different command", () => {
    // Two constructions in one file: the guard reads each one's own arguments,
    // so a conditional multipart completion cannot cover an unconditional put.
    const src = [
      "new PutObjectCommand({ Key: k, Body: b });",
      'new CompleteMultipartUploadCommand({ Key: k, IfNoneMatch: "*" });',
    ].join("\n");
    expect(constructionArguments(src, "PutObjectCommand")[0]).not.toContain(
      "IfNoneMatch",
    );
    expect(
      constructionArguments(src, "CompleteMultipartUploadCommand")[0],
    ).toContain("IfNoneMatch");
  });
});
