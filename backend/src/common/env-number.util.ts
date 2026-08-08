/**
 * Coercion helpers for numeric environment variables.
 *
 * Env vars arrive as strings (or as `undefined` when unset), so every numeric
 * knob has to coerce explicitly rather than trusting the value is already a
 * number. The distinction this file exists for is between *absent* and
 * *invalid*: both fall back to the default, but only one of them is a
 * deployment mistake worth logging. A silent fallback is how an operator sets
 * `AI_QUERY_MAX_ITERATIONS=ten` and spends an afternoon wondering why nothing
 * changed.
 */

export interface ResolvedPositiveInt {
  /** The value to use: the parsed override, or `fallback`. */
  value: number;
  /**
   * True when a value was supplied but was not a positive integer, so the
   * fallback was used instead. False when nothing was supplied at all --
   * an unset variable is not a misconfiguration.
   */
  invalid: boolean;
}

/**
 * Resolve a positive-integer setting from a (possibly string) environment
 * value. Missing, empty and whitespace-only values take the fallback without
 * complaint; anything else that is not a positive integer takes the fallback
 * and is reported as invalid.
 */
export function resolvePositiveInt(
  raw: unknown,
  fallback: number,
): ResolvedPositiveInt {
  if (raw === undefined || raw === null) {
    return { value: fallback, invalid: false };
  }
  // Only strings and numbers are coercible here. `Number()` is far too
  // willing otherwise -- it turns `true` into 1 and `[5]` into 5, so an
  // unguarded coercion would accept a config value that is plainly not a
  // number and silently run on it.
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { value: fallback, invalid: true };
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return { value: fallback, invalid: false };
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return { value: parsed, invalid: false };
  }
  return { value: fallback, invalid: true };
}
