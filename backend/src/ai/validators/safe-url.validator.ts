import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import * as dns from "dns";
import * as net from "net";
import {
  AiProviderType,
  SELF_HOSTED_PROVIDERS,
} from "../entities/ai-provider-config.entity";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "metadata",
]);

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^::1$/,
  /^::$/,
  /^::ffff:(?:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/i,
];

/**
 * The host as an address-comparable string.
 *
 * `URL.hostname` keeps the brackets on an IPv6 literal (`https://[::1]/` yields
 * `"[::1]"`), and every check below compares against unbracketed forms:
 * `net.isIP("[::1]")` is 0, `normalizeIp` returns null, and `/^::1$/` does not
 * match. So a bracketed loopback or link-local address passed the whole strict
 * check -- an SSRF bypass on any client-supplied URL, found by the push
 * endpoint's own validator spec. Stripping the brackets once, where the hostname
 * is derived, is what makes the existing rules apply to IPv6 at all.
 */
function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * The IPv4 address an IPv6 literal carries, or null.
 *
 * An IPv6 address can embed an IPv4 one, and the private-address rules are
 * written in dotted decimal -- so an embedded form has to be mapped back before
 * it is tested, or it is compared against patterns that cannot match it. There
 * are more spellings than the obvious one, and the URL parser rewrites all of
 * them to hex: `https://[::ffff:127.0.0.1]/` arrives as `::ffff:7f00:1`,
 * `https://[::127.0.0.1]/` as `::7f00:1`, and `https://[::ffff:0:127.0.0.1]/`
 * as `::ffff:0:7f00:1`. A rule spelled per-spelling covers whichever ones its
 * author thought of: the first pass here handled `::ffff:` with a two-group
 * tail and left IPv4-compatible and IPv4-translated loopback ACCEPTED.
 *
 * So the address is expanded to its eight groups and the known embedding
 * prefixes are matched on the groups, not on the text:
 *
 * - the zero-prefixed forms: IPv4-compatible (`::a.b.c.d`), IPv4-mapped
 *   (`::ffff:a.b.c.d`) and the deprecated IPv4-translated `::ffff:0:a.b.c.d`,
 *   which differ only in where the `ffff` sits.
 * - `64:ff9b::/96` and `64:ff9b:1::/48` -- the NAT64 prefixes, whose whole
 *   purpose is that a gateway forwards them to the embedded IPv4 address.
 *
 * Deliberately not covered: 6to4 (`2002::/16`) and Teredo (`2001::/32`), which
 * also embed an IPv4 address but reach it only through a relay this server
 * would have to be configured to use. They are named here so the omission is a
 * decision rather than an oversight.
 */
function embeddedIpv4(hostname: string): string | null {
  if (!net.isIPv6(hostname)) return null;

  const groups = expandIpv6(hostname);
  if (!groups) return null;

  // The three zero-prefixed embeddings, written as what distinguishes them:
  // groups 0-3 are zero in all of them, and the pair (4, 5) is (0, 0) for
  // IPv4-compatible, (0, ffff) for IPv4-mapped and (ffff, 0) for the
  // IPv4-translated form. Anything else in that pair is an ordinary IPv6
  // address whose last 32 bits mean nothing in particular.
  const zeroPrefix =
    groups.slice(0, 4).every((g) => g === 0) &&
    ((groups[4] === 0 && (groups[5] === 0 || groups[5] === 0xffff)) ||
      (groups[4] === 0xffff && groups[5] === 0));
  const nat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    // 64:ff9b::/96 has zeros through group 5; 64:ff9b:1::/48 sets group 2 to 1.
    (groups[2] === 0 || groups[2] === 1) &&
    groups.slice(3, 6).every((g) => g === 0);
  if (!zeroPrefix && !nat64) return null;

  const high = groups[6];
  const low = groups[7];
  return [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

/**
 * An IPv6 literal as eight numeric groups, `::` expanded and a dotted IPv4 tail
 * folded into the last two. Returns null for anything it cannot read, so a
 * caller never sees a partially parsed address.
 */
function expandIpv6(hostname: string): number[] | null {
  let text = hostname;

  // A dotted tail (`::ffff:127.0.0.1`) is two groups. Node's parser normally
  // rewrites it, but this function is also handed addresses from DNS answers.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const octets = dotted[1].split(".").map((o) => parseInt(o, 10));
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left === null || right === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * Normalize an IP address string to dotted-decimal (IPv4),
 * catching hex/octal/decimal encoded IPs that bypass regex-based checks.
 */
function normalizeIp(hostname: string): string | null {
  // An embedded IPv4 first, because such an address IS a valid IPv6 literal and
  // `net.isIP` below would return it unchanged for the IPv6 patterns to test --
  // which spell loopback and private space in dotted decimal. Mapping it back
  // is what puts it in front of the IPv4 rules that already cover it.
  const embedded = embeddedIpv4(hostname);
  if (embedded) return embedded;

  if (net.isIP(hostname)) return hostname;

  try {
    // Decimal IP: e.g. 2130706433 => 127.0.0.1
    if (/^\d{1,10}$/.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (num >= 0 && num <= 0xffffffff) {
        return [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join(".");
      }
    }
    // Hex IP: e.g. 0x7f000001
    if (/^0x[0-9a-f]{1,8}$/i.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (num >= 0 && num <= 0xffffffff) {
        return [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join(".");
      }
    }
    // Octal-dotted IP: e.g. 0177.0.0.1
    if (/^0\d+(\.\d+){0,3}$/.test(hostname)) {
      const parts = hostname.split(".");
      if (parts.length <= 4 && parts.every((p) => /^0?\d+$/.test(p))) {
        const octets = parts.map((p) =>
          p.startsWith("0") && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10),
        );
        if (octets.every((o) => o >= 0 && o <= 255)) {
          return octets.join(".");
        }
      }
    }
  } catch {
    // Parsing failed, not a numeric IP
  }
  return null;
}

/**
 * Whether an address is one this server must not be sent to.
 *
 * The embedded-IPv4 mapping happens HERE rather than only at the hostname,
 * because this function is also handed the answers to a DNS lookup: a name with
 * an AAAA record of `::7f00:1` is the rebinding half of the same bypass, and it
 * never passes through `normalizeIp`.
 */
function isPrivateIp(ip: string): boolean {
  const embedded = embeddedIpv4(ip);
  const candidates = embedded ? [ip, embedded] : [ip];
  for (const candidate of candidates) {
    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(candidate)) return true;
    }
  }
  return false;
}

function dnsResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses);
    });
  });
}

function dnsResolve6(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.resolve6(hostname, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses);
    });
  });
}

@ValidatorConstraint({ async: true })
export class IsSafeUrlConstraint implements ValidatorConstraintInterface {
  async validate(value: unknown): Promise<boolean> {
    if (typeof value !== "string") return false;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = unbracketHost(parsed.hostname.toLowerCase());

    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return false;
    }

    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) {
        return false;
      }
    }

    // Check for alternative IP encodings (hex, decimal, octal, IPv6-mapped)
    const normalizedIp = normalizeIp(hostname);
    if (normalizedIp && isPrivateIp(normalizedIp)) {
      return false;
    }

    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(hostname)) {
        return false;
      }
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    // DNS resolution check: resolve hostname and verify IPs are not private
    if (!net.isIP(hostname) && !normalizedIp) {
      try {
        const [ipv4Addrs, ipv6Addrs] = await Promise.all([
          dnsResolve(hostname),
          dnsResolve6(hostname),
        ]);
        const allAddrs = [...ipv4Addrs, ...ipv6Addrs];
        // Reject if ANY resolved address is private (prevents DNS rebinding)
        if (allAddrs.length > 0 && allAddrs.some((ip) => isPrivateIp(ip))) {
          return false;
        }
      } catch {
        // DNS resolution failed — allow the URL (the actual HTTP request will fail)
      }
    }

    return true;
  }

  defaultMessage(): string {
    return "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host";
  }
}

/**
 * Standalone function to validate a URL is safe (not targeting private/internal IPs).
 * Can be used outside of class-validator context (e.g. validating env vars at startup).
 */
export async function validateUrlIsSafe(url: string): Promise<boolean> {
  const validator = new IsSafeUrlConstraint();
  return validator.validate(url);
}

/**
 * How long a safety check may take before the answer is "not established".
 *
 * The check resolves the host, and `dns.resolve4`/`resolve6` carry no timeout of
 * their own -- so a name whose authoritative nameserver never answers holds the
 * caller for c-ares' whole retry budget, tens of seconds. That is a value
 * somebody else chooses, on a request path: `IsPushEndpoint` runs this check on
 * `POST /push/subscriptions` before any row exists, and the AI provider's
 * `baseUrl` field runs it on a save.
 *
 * A check that has not answered in this long has not established the host is
 * safe, and an unestablished host is not sent to -- so the timeout answers
 * `false`, never "probably fine". Two seconds is far past a working resolver
 * and far short of a lever.
 */
export const URL_SAFETY_CHECK_TIMEOUT_MS = 2_000;

/**
 * `validateUrlIsSafe` under a deadline.
 *
 * The bound is here, beside the check it bounds, rather than at each caller: the
 * push sender had its own 2-second race and the validator on the same path had
 * none, which is exactly the shape of a rule written twice.
 */
export async function validateUrlIsSafeWithin(
  url: string,
  timeoutMs: number = URL_SAFETY_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      validateUrlIsSafe(url),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Lighter validation for self-hosted providers (Ollama, OpenAI-compatible) that are
 * expected to run on private/local networks. Only checks protocol and rejects
 * embedded credentials.
 */
export function validateUrlBasicSafety(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  return true;
}

export function IsSafeUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsSafeUrlConstraint,
    });
  };
}

/**
 * SSRF guard for AI provider baseUrl values. Dispatches on the sibling
 * `provider` field: cloud providers get the strict IsSafeUrl check (blocks
 * private IPs, metadata endpoints, DNS-rebinding) while self-hosted providers
 * (ollama, openai-compatible) intentionally allow private/local URLs since
 * they run on LAN.
 */
@ValidatorConstraint({ async: true })
export class IsSafeProviderBaseUrlConstraint implements ValidatorConstraintInterface {
  private lastMessage = "baseUrl must be a valid HTTP/HTTPS URL";

  async validate(value: unknown, args: ValidationArguments): Promise<boolean> {
    if (typeof value !== "string" || value.length === 0) return false;

    const provider = (args.object as { provider?: AiProviderType }).provider;

    // No provider in the DTO means we can't pick the right policy at the
    // validation layer (e.g. UpdateAiConfigDto, where provider is immutable
    // and not echoed in the request). Fall back to basic safety here and let
    // the service layer run provider-aware validation against the stored row.
    if (!provider) {
      if (!validateUrlBasicSafety(value)) {
        this.lastMessage =
          "baseUrl must be a valid HTTP/HTTPS URL without embedded credentials";
        return false;
      }
      return true;
    }

    if (SELF_HOSTED_PROVIDERS.has(provider)) {
      if (!validateUrlBasicSafety(value)) {
        this.lastMessage =
          "baseUrl must be a valid HTTP/HTTPS URL without embedded credentials";
        return false;
      }
      return true;
    }

    const strict = new IsSafeUrlConstraint();
    const ok = await strict.validate(value);
    if (!ok) {
      this.lastMessage =
        "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host";
    }
    return ok;
  }

  defaultMessage(): string {
    return this.lastMessage;
  }
}

export function IsSafeProviderBaseUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsSafeProviderBaseUrlConstraint,
    });
  };
}
