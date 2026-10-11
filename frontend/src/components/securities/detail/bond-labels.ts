/** The subset of next-intl's translator the label helpers need. */
interface Translator {
  (key: string): string;
  has: (key: string) => boolean;
}

/** A benchmark by its translated name where the catalog has one, else by its id. */
export function benchmarkLabel(t: Translator, benchmarkId: string): string {
  return t.has(`bond.benchmarks.${benchmarkId}`)
    ? t(`bond.benchmarks.${benchmarkId}`)
    : benchmarkId;
}

/** An issuer by its translated name where the catalog has one, else by its code. */
export function issuerLabel(t: Translator, issuerCode: string): string {
  return t.has(`bond.issuers.${issuerCode}`)
    ? t(`bond.issuers.${issuerCode}`)
    : issuerCode;
}

/** A program by its translated name where the catalog has one, else by its code. */
export function programLabel(t: Translator, programCode: string): string {
  return t.has(`bond.programs.${programCode}`)
    ? t(`bond.programs.${programCode}`)
    : programCode;
}
