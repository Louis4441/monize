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
 * Normalize an IP address string to dotted-decimal (IPv4),
 * catching hex/octal/decimal encoded IPs that bypass regex-based checks.
 */
function normalizeIp(hostname: string): string | null {
  // IPv4-mapped IPv6 first, because such an address IS a valid IPv6 literal and
  // would otherwise be returned unchanged for the IPv6 patterns to test -- and
  // those only spell the dotted form (`::ffff:127.0.0.1`), while Node's URL
  // parser normalizes it to hex (`::ffff:7f00:1`). Mapping it back to dotted
  // decimal is what puts it in front of the IPv4 rules that already cover it.
  const mapped = /^::ffff:(.+)$/i.exec(hostname);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return tail;
    const groups = tail.split(":");
    if (
      groups.length === 2 &&
      groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))
    ) {
      const high = parseInt(groups[0], 16);
      const low = parseInt(groups[1], 16);
      return [
        (high >>> 8) & 0xff,
        high & 0xff,
        (low >>> 8) & 0xff,
        low & 0xff,
      ].join(".");
    }
  }

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

function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(ip)) return true;
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
