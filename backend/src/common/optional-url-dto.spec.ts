import { readdirSync } from "fs";
import { join } from "path";
import { getMetadataStorage, validate } from "class-validator";
import { plainToInstance } from "class-transformer";

/**
 * Guard: an optional URL field must accept the empty string.
 *
 * `@IsOptional()` waives validation for `undefined` and `null` only. A text
 * input the user never touched arrives as `""`, so a format validator sitting
 * beside `@IsOptional()` still runs on it and rejects it -- and because
 * validation fails the whole request, one blank optional field breaks every save
 * from the form. That is how `securities.website` shipped: the securities form
 * could not create or update anything, and no unit test noticed because none of
 * them submits the form's actual payload.
 *
 * The fix is `@ValidateIf((_o, value) => value !== null && value !== "")`
 * alongside `@IsOptional()`. This test finds the next one automatically rather
 * than trusting the next author to remember, in the shape of
 * `frontend/src/test/ui-conventions.test.ts`.
 *
 * Scoped to URLs on purpose. Optional UUID and date properties are cleared by
 * sending `null` throughout this codebase, and there are around a hundred of
 * them, so extending the rule there would be a large behavioural change wearing
 * a test's clothes rather than a guard.
 */

/** Every `*.dto.ts` file under src/, so each one can be imported below. */
function dtoFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".dto.ts")) {
        files.push(path);
      }
    }
  };
  walk(join(__dirname, ".."));
  return files;
}

/**
 * The loaded modules, so their decorators have run and registered metadata.
 *
 * `require` rather than `await import`: the dynamic form makes ts-jest compile
 * every DTO in a separate async tick and the sweep takes minutes. Same exemption
 * the other specs in this repo use for a computed module path.
 */
function dtoModules(): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return dtoFiles().map((path) => require(path));
}

interface UrlProperty {
  readonly cls: new () => object;
  readonly name: string;
  readonly property: string;
}

/** Errors reported against one property, ignoring the rest of the payload. */
async function errorsFor(
  cls: new () => object,
  property: string,
  value: unknown,
): Promise<string[]> {
  const instance = plainToInstance(cls, { [property]: value });
  const errors = await validate(instance);
  return errors
    .filter((error) => error.property === property)
    .flatMap((error) => Object.keys(error.constraints ?? {}));
}

/**
 * Every DTO property that validates as a URL, found by asking each property what
 * it thinks of a string that is plainly not one and keeping those that answer
 * `isUrl`.
 *
 * Behavioural rather than metadata-shaped on purpose: class-validator files
 * every decorator built on `registerDecorator` under `customValidation`, so the
 * stored metadata does not name the constraint, while the reported error always
 * does. This also finds a property that inherits the decorator through
 * `PartialType` or a base class, which source-scanning would miss.
 */
async function urlProperties(): Promise<UrlProperty[]> {
  const storage = getMetadataStorage();
  const found: UrlProperty[] = [];
  for (const module of dtoModules()) {
    for (const exported of Object.values(module as Record<string, unknown>)) {
      if (typeof exported !== "function") continue;
      const cls = exported as new () => object;
      const properties = new Set(
        storage
          .getTargetValidationMetadatas(cls, "", false, false)
          .map((meta) => meta.propertyName),
      );
      for (const property of properties) {
        const verdict = await errorsFor(cls, property, "definitely not a url");
        if (verdict.includes("isUrl")) {
          found.push({ cls, name: cls.name, property });
        }
      }
    }
  }
  return found;
}

/**
 * Optional-looking URL properties that are *right* to reject a blank, with the
 * reason. Both are `PartialType` update DTOs over a NOT NULL column: the value
 * cannot be stored empty, so rejecting "" is the honest answer and the form
 * requires the field client-side to match.
 *
 * The exemption is spelled out rather than inferred because nothing visible from
 * a DTO says whether its column is nullable. Ending up on this list should be a
 * decision, not an accident -- which is the whole point of the guard.
 */
const INTENTIONALLY_REJECTS_BLANK: Record<string, string> = {
  "UpdateInstitutionDto.website":
    "institutions.website is NOT NULL and resolves the brand favicon",
  "UpdateSecurityDocumentDto.url":
    "security_documents.url is NOT NULL -- a document with no address is not a document",
};

describe("optional URL fields accept the empty string a form sends", () => {
  it("finds the URL-validated DTO properties, so the sweep is not vacuous", async () => {
    // Were the discovery to break, the sweep below would pass over an empty
    // list and this guard would silently stop guarding.
    expect((await urlProperties()).length).toBeGreaterThan(0);
  });

  it("waives the URL check on every optional address", async () => {
    const offenders: string[] = [];
    for (const { cls, name, property } of await urlProperties()) {
      const label = `${name}.${property}`;
      if (label in INTENTIONALLY_REJECTS_BLANK) continue;

      // A property that validates when absent is optional; a required one is
      // meant to reject "" and is not what this guard is about.
      const whenAbsent = await errorsFor(cls, property, undefined);
      if (whenAbsent.length > 0) continue;

      const whenBlank = await errorsFor(cls, property, "");
      if (whenBlank.length > 0) {
        offenders.push(`${label}: ${whenBlank.join(", ")}`);
      }
    }
    // Either add `@ValidateIf((_o, value) => value !== null && value !== "")`
    // beside the `@IsOptional()`, or list the property above with the reason its
    // column cannot hold a blank.
    expect(offenders).toEqual([]);
  });

  it("keeps the exemption list free of properties that no longer need it", async () => {
    // The teeth: an exemption that stops applying has to leave the list, so the
    // list can only ever get shorter.
    const rejectsBlank: string[] = [];
    for (const { cls, name, property } of await urlProperties()) {
      const whenBlank = await errorsFor(cls, property, "");
      if (whenBlank.length > 0) rejectsBlank.push(`${name}.${property}`);
    }
    const stale = Object.keys(INTENTIONALLY_REJECTS_BLANK).filter(
      (label) => !rejectsBlank.includes(label),
    );
    expect(stale).toEqual([]);
  });
});
