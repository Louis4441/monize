import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/components/scheduled-transactions/ScheduledTransactionList.tsx'),
  'utf8',
);

describe('ScheduledTransactionList translations', () => {
  it('routes category markers and the moved-date title through the catalogue', () => {
    expect(source).toContain("t('form.tabs.transfer')");
    expect(source).toContain("t('form.tabs.investment')");
    expect(source).toContain("t('list.splitBadge'");
    expect(source).toContain("t('list.modifiedDateTitle')");

    expect(source).not.toMatch(/bound\(['"]Transfer['"]\)/);
    expect(source).not.toMatch(/transaction\.investmentAction \|\| ['"]Investment['"]/);
    expect(source).not.toMatch(/title=['"]Date modified for this occurrence['"]/);
    expect(source).not.toMatch(/<>Split \(\{/);
  });
});
