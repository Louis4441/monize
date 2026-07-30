/**
 * Rows per INSERT, and the splitter every `.mny` writer uses.
 *
 * Large enough to amortise the round trip -- one awaited INSERT per row is what
 * made PR #192's migration take hours -- and small enough that a wide row stays
 * well under Postgres's 65,535 bind-parameter ceiling.
 */
export const INSERT_CHUNK_SIZE = 500;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
