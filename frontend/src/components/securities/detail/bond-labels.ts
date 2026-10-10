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
