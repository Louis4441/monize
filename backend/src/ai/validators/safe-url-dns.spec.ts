import * as dns from "dns";

jest.mock("dns", () => ({
  resolve4: jest.fn(),
  resolve6: jest.fn(),
}));

import {
  URL_SAFETY_CHECK_TIMEOUT_MS,
  validateUrlIsSafe,
  validateUrlIsSafeWithin,
} from "./safe-url.validator";

type Callback = (err: Error | null, addresses?: string[]) => void;

const resolve4 = dns.resolve4 as unknown as jest.Mock;
const resolve6 = dns.resolve6 as unknown as jest.Mock;

/** Answer both lookups; either list may be empty. */
function answers(ipv4: string[], ipv6: string[]): void {
  resolve4.mockImplementation((_host: string, cb: Callback) => cb(null, ipv4));
  resolve6.mockImplementation((_host: string, cb: Callback) => cb(null, ipv6));
}

/**
 * The two halves of the safety check that only a controlled resolver can reach:
 * what a NAME resolves to, and what happens when the resolver never answers.
 *
 * `dns.resolve4`/`resolve6` take a callback and carry no timeout of their own,
 * so both properties are invisible to a spec that lets the real resolver run --
 * and the timeout half is what turned a save into a request held open for the
 * whole c-ares retry budget.
 */
describe("the safety check against a controlled resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    answers([], []);
  });

  describe("what the name resolves to", () => {
    it("rejects a name whose A record is private (DNS rebinding)", async () => {
      answers(["10.0.0.5"], []);

      await expect(validateUrlIsSafe("https://rebind.test/x")).resolves.toBe(
        false,
      );
    });

    // The IPv6 half of the same bypass. A resolver answers in hex, so an
    // embedded-IPv4 loopback arrives as `::7f00:1` -- which reaches
    // `isPrivateIp` directly and never passes through the hostname's own
    // normalization. Mapping only at the hostname left this accepted.
    it.each([
      ["an IPv4-compatible loopback", "::7f00:1"],
      ["a mapped loopback", "::ffff:7f00:1"],
      ["a translated private address", "::ffff:0:c0a8:1"],
      ["a unique-local address", "fd00::1"],
      ["plain loopback", "::1"],
    ])("rejects a name whose AAAA record is %s", async (_name, address) => {
      answers([], [address]);

      await expect(validateUrlIsSafe("https://rebind.test/x")).resolves.toBe(
        false,
      );
    });

    it("allows a name that resolves publicly on both families", async () => {
      answers(["93.184.216.34"], ["2606:4700::1111"]);

      await expect(validateUrlIsSafe("https://example.test/x")).resolves.toBe(
        true,
      );
    });
  });

  describe("a resolver that never answers", () => {
    /** Neither callback is ever invoked, which is what a black hole looks like. */
    function neverAnswers(): void {
      resolve4.mockImplementation(() => undefined);
      resolve6.mockImplementation(() => undefined);
    }

    it("is not established as safe, so the bounded check answers false", async () => {
      neverAnswers();

      await expect(
        validateUrlIsSafeWithin("https://blackhole.test/x", 20),
      ).resolves.toBe(false);
    });

    // The reason the bound exists rather than being left to each caller: the
    // unbounded call does not settle at all, and it sat in front of a 400 on a
    // request an authenticated caller can make twenty times a minute.
    it("leaves the unbounded check unsettled", async () => {
      neverAnswers();

      const settled = jest.fn();
      void validateUrlIsSafe("https://blackhole.test/x").then(settled);
      await new Promise((resolve) => setImmediate(resolve));

      expect(settled).not.toHaveBeenCalled();
    });

    it("bounds by default at the documented timeout", () => {
      // Two seconds: far past a working resolver, far short of a lever. Pinned
      // because `sendTest`'s documented worst case is composed from it.
      expect(URL_SAFETY_CHECK_TIMEOUT_MS).toBe(2_000);
    });
  });

  // A safe URL must not be delayed by the bound, and a check that answers
  // before the timer is the ordinary case.
  it("returns the check's own answer when it finishes in time", async () => {
    answers(["93.184.216.34"], []);

    await expect(
      validateUrlIsSafeWithin("https://example.test/x", 5_000),
    ).resolves.toBe(true);
  });
});
