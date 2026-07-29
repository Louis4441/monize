import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "../__fixtures__/mny-fixtures";
import {
  MnyImportError,
  MnyPasswordIncorrectError,
  MnyPasswordRequiredError,
  MnyUnsupportedVersionError,
} from "../mny-errors";
import { JET_PAGE_SIZE, OFFSET_VERSION_BYTE, VERSION_JET3 } from "./jet-header";
import { decryptMsisamInPlace } from "./msisam-decrypt";

/** First byte of a Jet page is its page type; 0x02 marks a table definition. */
const PAGE_TYPE_TABLE_DEFINITION = 0x02;

function pageType(file: Buffer, page: number): number {
  return file[page * JET_PAGE_SIZE];
}

function caught(fn: () => unknown): MnyImportError {
  try {
    fn();
  } catch (error) {
    return error as MnyImportError;
  }
  throw new Error("expected the call to throw");
}

describe("decryptMsisamInPlace", () => {
  const cases: ReadonlyArray<[MnyFixtureName, string, boolean]> = [
    ["money2001", "old", false],
    ["money2001Pwd", "old", false],
    ["money2002", "new-md5", false],
    ["money2008", "new-sha1", false],
    ["money2008Pwd", "new-sha1", true],
  ];

  it.each(cases)(
    "decrypts %s with the %s scheme",
    (fixture, scheme, passwordProtected) => {
      const file = readMnyFixture(fixture);

      const result = decryptMsisamInPlace(file, MNY_FIXTURES[fixture].password);

      expect(result.scheme).toBe(scheme);
      expect(result.passwordProtected).toBe(passwordProtected);
      // Page 2 holds the MSysObjects table definition in every Jet 4 database;
      // a wrong key leaves it as ciphertext.
      expect(pageType(result.buffer, 2)).toBe(PAGE_TYPE_TABLE_DEFINITION);
    },
  );

  it("returns the buffer it was given rather than a copy", () => {
    const file = readMnyFixture("money2002");

    expect(decryptMsisamInPlace(file).buffer).toBe(file);
  });

  it("leaves the header page and the plaintext pages alone", () => {
    const original = readMnyFixture("money2008");
    const decrypted = decryptMsisamInPlace(readMnyFixture("money2008"));

    expect(
      decrypted.buffer
        .subarray(0, JET_PAGE_SIZE)
        .equals(original.subarray(0, JET_PAGE_SIZE)),
    ).toBe(true);
    expect(
      decrypted.buffer
        .subarray(15 * JET_PAGE_SIZE)
        .equals(original.subarray(15 * JET_PAGE_SIZE)),
    ).toBe(true);
  });

  it("changes every encrypted page", () => {
    const original = readMnyFixture("money2002");
    const decrypted = decryptMsisamInPlace(readMnyFixture("money2002"));

    for (let page = 1; page <= 0x0e; page++) {
      const start = page * JET_PAGE_SIZE;
      const end = start + JET_PAGE_SIZE;
      expect(
        decrypted.buffer
          .subarray(start, end)
          .equals(original.subarray(start, end)),
      ).toBe(false);
    }
  });

  it("ignores a password supplied for a file that does not need one", () => {
    const result = decryptMsisamInPlace(
      readMnyFixture("money2008"),
      "unnecessary",
    );

    expect(result.passwordProtected).toBe(false);
    expect(pageType(result.buffer, 2)).toBe(PAGE_TYPE_TABLE_DEFINITION);
  });

  it("ignores a password on pre-2002 files, which derive the key from the header", () => {
    const result = decryptMsisamInPlace(
      readMnyFixture("money2001Pwd"),
      "whatever",
    );

    expect(result.scheme).toBe("old");
    expect(pageType(result.buffer, 2)).toBe(PAGE_TYPE_TABLE_DEFINITION);
  });

  it("asks for a password when the file is protected and none was given", () => {
    const error = caught(() =>
      decryptMsisamInPlace(readMnyFixture("money2008Pwd")),
    );

    expect(error).toBeInstanceOf(MnyPasswordRequiredError);
    expect(error.code).toBe("mnyPasswordRequired");
  });

  it("reports an incorrect password distinctly", () => {
    const error = caught(() =>
      decryptMsisamInPlace(readMnyFixture("money2008Pwd"), "WrongPassword"),
    );

    expect(error).toBeInstanceOf(MnyPasswordIncorrectError);
    expect(error.code).toBe("mnyPasswordIncorrect");
  });

  it("never echoes the password in the error message", () => {
    const error = caught(() =>
      decryptMsisamInPlace(readMnyFixture("money2008Pwd"), "hunter2"),
    );

    expect(error.message).not.toContain("hunter2");
  });

  it("treats the password case-insensitively, as Money does", () => {
    const result = decryptMsisamInPlace(
      readMnyFixture("money2008Pwd"),
      "tEsT12345",
    );

    expect(result.passwordProtected).toBe(true);
    expect(pageType(result.buffer, 2)).toBe(PAGE_TYPE_TABLE_DEFINITION);
  });

  it("propagates header validation failures", () => {
    const file = readMnyFixture("money2002");
    file[OFFSET_VERSION_BYTE] = VERSION_JET3;

    expect(() => decryptMsisamInPlace(file)).toThrow(
      MnyUnsupportedVersionError,
    );
  });

  it("stops at the last page a short file actually has", () => {
    // A header plus four pages: the loop must not run past the buffer.
    const file = readMnyFixture("money2002").subarray(0, JET_PAGE_SIZE * 5);

    const result = decryptMsisamInPlace(Buffer.from(file));

    expect(result.buffer).toHaveLength(JET_PAGE_SIZE * 5);
    expect(pageType(result.buffer, 2)).toBe(PAGE_TYPE_TABLE_DEFINITION);
  });
});
