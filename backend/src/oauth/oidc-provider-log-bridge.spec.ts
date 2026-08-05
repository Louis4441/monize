import {
  installOidcProviderLogBridge,
  parseOidcProviderLine,
} from "./oidc-provider-log-bridge";

describe("parseOidcProviderLine()", () => {
  it("routes a NOTICE to log level and strips the library prefix", () => {
    expect(
      parseOidcProviderLine(
        "oidc-provider NOTICE: default ttl.Session function called, you SHOULD change it.",
      ),
    ).toEqual({
      level: "log",
      message:
        "default ttl.Session function called, you SHOULD change it.".trim(),
    });
  });

  it("routes a WARNING to warn level", () => {
    expect(
      parseOidcProviderLine(
        "oidc-provider WARNING: already parsed request body detected",
      ),
    ).toEqual({
      level: "warn",
      message: "already parsed request body detected",
    });
  });

  it("strips the colour wrapper the library adds on a TTY", () => {
    // attention.js wraps the whole line in bold yellow/red when stdout is a TTY.
    const coloured = "\x1b[33;1moidc-provider NOTICE: coloured line\x1b[0m";
    expect(parseOidcProviderLine(coloured)).toEqual({
      level: "log",
      message: "coloured line",
    });
  });

  it("keeps a multi-line notice intact", () => {
    expect(
      parseOidcProviderLine("oidc-provider NOTICE: first line\n  second line"),
    ).toEqual({ level: "log", message: "first line\n  second line" });
  });

  it("ignores anything that is not an oidc-provider attention line", () => {
    expect(
      parseOidcProviderLine("some other library said something"),
    ).toBeNull();
    expect(parseOidcProviderLine("NOTICE: oidc-provider mentioned")).toBeNull();
    expect(parseOidcProviderLine(42)).toBeNull();
    expect(parseOidcProviderLine(undefined)).toBeNull();
  });
});

describe("installOidcProviderLogBridge()", () => {
  let logger: { log: jest.Mock; warn: jest.Mock };
  let originalInfo: typeof console.info;
  let originalWarn: typeof console.warn;
  let restore: () => void;

  beforeEach(() => {
    logger = { log: jest.fn(), warn: jest.fn() };
    originalInfo = console.info;
    originalWarn = console.warn;
    console.info = jest.fn();
    console.warn = jest.fn();
    restore = installOidcProviderLogBridge(logger);
  });

  afterEach(() => {
    restore();
    console.info = originalInfo;
    console.warn = originalWarn;
  });

  it("sends an oidc-provider notice to the logger instead of the console", () => {
    console.info("oidc-provider NOTICE: default ttl.Grant function called");

    expect(logger.log).toHaveBeenCalledWith(
      "default ttl.Grant function called",
    );
    expect(console.info).toBeInstanceOf(Function);
  });

  it("sends an oidc-provider warning to the logger at warn level", () => {
    console.warn("oidc-provider WARNING: a quick start adapter is used");

    expect(logger.warn).toHaveBeenCalledWith("a quick start adapter is used");
  });

  it("passes unrelated console output straight through", () => {
    console.info("unrelated", { a: 1 });
    console.warn("also unrelated");

    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is idempotent -- installing twice does not stack wrappers", () => {
    const second = installOidcProviderLogBridge(logger);
    expect(second).toBe(restore);

    console.info("oidc-provider NOTICE: once only");
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it("restores the original console methods on uninstall", () => {
    const patchedInfo = console.info;
    restore();
    expect(console.info).not.toBe(patchedInfo);

    console.info("oidc-provider NOTICE: after uninstall");
    expect(logger.log).not.toHaveBeenCalled();

    // The afterEach hook calls restore() again; make it a no-op.
    restore = () => {};
  });
});
