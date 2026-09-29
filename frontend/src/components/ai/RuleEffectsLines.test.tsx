import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@/test/render';
import { RuleEffectsLines } from './RuleEffectsLines';
import type { PendingActionRuleEffects } from '@/types/ai';

const labels = { categories: {}, payees: { 'pay-1': 'Starbucks' }, tags: {}, rules: {} };

function effects(changes: Partial<PendingActionRuleEffects['changes']>): PendingActionRuleEffects {
  return { changes: { addTagIds: [], removeTagIds: [], ...changes }, aiReviewRequests: [], labels };
}

describe('RuleEffectsLines: the text actions', () => {
  it('says a payee named by text will be created when the row is saved', () => {
    render(<RuleEffectsLines effects={effects({ payeeName: 'Corner Cafe', createPayee: 'Corner Cafe' })} />);
    expect(within(screen.getByTestId('rule-effects')).getByText('A new payee will be created: Corner Cafe')).toBeInTheDocument();
  });

  it('names a payee chosen by text that no id stands for', () => {
    render(<RuleEffectsLines effects={effects({ payeeName: 'Corner Cafe' })} />);
    expect(screen.getByText('Set the payee to Corner Cafe')).toBeInTheDocument();
  });

  it('prefers the payee found by id, and says nothing twice', () => {
    render(<RuleEffectsLines effects={effects({ payeeId: 'pay-1', payeeName: 'Starbucks' })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Set the payee to Starbucks')).toBeInTheDocument();
  });

  it('says what the description will be', () => {
    render(<RuleEffectsLines effects={effects({ description: 'POS 1 / REF 9' })} />);
    expect(screen.getByText('Set the description to "POS 1 / REF 9"')).toBeInTheDocument();
  });

  it('renders nothing when the rules do nothing to the text', () => {
    const { container } = render(<RuleEffectsLines effects={effects({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});
