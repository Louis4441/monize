/**
 * Error taxonomy for the Microsoft Money (`.mny`) import pipeline.
 *
 * Every failure the parser can produce carries a stable `code`. The controller
 * layer maps the code to an i18n key (`import.mny.<code>`) so the wizard can
 * show an actionable message -- most importantly telling "this file needs a
 * password" apart from "that password is wrong".
 */
export type MnyErrorCode =
  /** File is shorter than a single Jet page, or truncated mid-upload. */
  | "mnyFileTruncated"
  /** Header does not identify a Microsoft Money database. */
  | "mnyNotAMoneyFile"
  /** Jet 3 era file (Money 97/98) -- not supported. */
  | "mnyUnsupportedVersion"
  /** File is password protected and no password was supplied. */
  | "mnyPasswordRequired"
  /** A password was supplied but it does not open the file. */
  | "mnyPasswordIncorrect"
  /** Decryption succeeded but the page structure could not be parsed. */
  | "mnyUnreadableDatabase";

/**
 * Base class for every `.mny` parse failure. Never include the password (or
 * any part of it) in `message` -- these messages are logged.
 */
export class MnyImportError extends Error {
  constructor(
    readonly code: MnyErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class MnyFileTruncatedError extends MnyImportError {
  constructor(actualBytes: number, expectedBytes: number) {
    super(
      "mnyFileTruncated",
      `Money file is only ${actualBytes} bytes; at least ${expectedBytes} are needed to read the header`,
    );
  }
}

export class MnyNotAMoneyFileError extends MnyImportError {
  constructor(engineName: string) {
    super(
      "mnyNotAMoneyFile",
      `File does not look like a Microsoft Money database (engine name "${engineName}")`,
    );
  }
}

export class MnyUnsupportedVersionError extends MnyImportError {
  constructor(versionByte: number) {
    super(
      "mnyUnsupportedVersion",
      `Unsupported Money file version 0x${versionByte.toString(16)}; Money 97/98 (Jet 3) files must first be converted with Money Plus Sunset`,
    );
  }
}

export class MnyPasswordRequiredError extends MnyImportError {
  constructor() {
    super("mnyPasswordRequired", "Money file is password protected");
  }
}

export class MnyPasswordIncorrectError extends MnyImportError {
  constructor() {
    super("mnyPasswordIncorrect", "Money file password is incorrect");
  }
}

export class MnyUnreadableDatabaseError extends MnyImportError {
  constructor(cause: unknown) {
    super(
      "mnyUnreadableDatabase",
      "Money file was decrypted but its contents could not be read",
      cause,
    );
  }
}
