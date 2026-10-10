import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { ExactDecimal } from "./domain/exact-decimal";

/** The most values one scenarios request may value (spec 13.3). */
export const MAX_SCENARIO_VALUES = 6;

const BENCHMARK_ID = /^[A-Z0-9_]{1,40}$/;
const DECIMAL = /^-?\d{1,3}(\.\d{1,10})?$/;
const LOWER = ExactDecimal.parse("-0.5");
const UPPER = ExactDecimal.parse("1.0");

/** A benchmark value as a fraction between -0.5 and 1.0; the text as given, or null. */
function boundedFraction(value: unknown): string | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const parsed = ExactDecimal.parse(value);
  return parsed.cmp(LOWER) < 0 || parsed.cmp(UPPER) > 0 ? null : value;
}

function isBenchmarkId(value: unknown): value is string {
  return typeof value === "string" && BENCHMARK_ID.test(value);
}

/**
 * `assume=<benchmarkId>:<value>` of the valuation route as the engine's
 * projection map; absent or empty is no assumption. The type is checked before
 * the text, so a repeated key (an array) is refused rather than coerced.
 */
@Injectable()
export class ParseAssumePipe implements PipeTransform<
  unknown,
  ReadonlyMap<string, string> | undefined
> {
  transform(value: unknown): ReadonlyMap<string, string> | undefined {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string") {
      const at = value.indexOf(":");
      const benchmarkId = at < 0 ? null : value.slice(0, at);
      const fraction = at < 0 ? null : boundedFraction(value.slice(at + 1));
      if (isBenchmarkId(benchmarkId) && fraction !== null) {
        return new Map([[benchmarkId, fraction]]);
      }
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.assumeInvalid",
        "assume must be benchmarkId:value, with a benchmark id of 1 to 40 capital letters, digits or underscores and a decimal value between -0.5 and 1.0",
      ),
    );
  }
}

/** `benchmarkId` of the scenarios route. */
@Injectable()
export class ParseBenchmarkIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (isBenchmarkId(value)) return value;
    throw new BadRequestException(
      tr(
        "errors.bonds.benchmarkIdInvalid",
        "benchmarkId must be 1 to 40 capital letters, digits or underscores",
      ),
    );
  }
}

/** `values=a,b,c` of the scenarios route: 1 to 6 decimals between -0.5 and 1.0. */
@Injectable()
export class ParseScenarioValuesPipe implements PipeTransform<
  unknown,
  readonly string[]
> {
  transform(value: unknown): readonly string[] {
    if (typeof value === "string") {
      const parts = value.split(",").map((part) => part.trim());
      if (parts.length >= 1 && parts.length <= MAX_SCENARIO_VALUES) {
        const fractions = parts.map(boundedFraction);
        if (fractions.every((f): f is string => f !== null)) return fractions;
      }
    }
    throw new BadRequestException(
      tr(
        "errors.bonds.scenarioValuesInvalid",
        "values must be 1 to 6 comma-separated decimals between -0.5 and 1.0",
      ),
    );
  }
}
