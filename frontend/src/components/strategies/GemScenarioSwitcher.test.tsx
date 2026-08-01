import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
import { GemScenarioSwitcher } from './GemScenarioSwitcher';

const twoScenarios = [
  { id: 'strategy-1', name: 'GEM 12m' },
  { id: 'strategy-2', name: 'GEM 6m' },
];

const renderSwitcher = (overrides: Record<string, unknown> = {}) => {
  const onSelect = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <GemScenarioSwitcher
      currentId="strategy-1"
      currentName="GEM 12m"
      scenarios={twoScenarios}
      onSelect={onSelect}
      onCreate={onCreate}
      onDelete={onDelete}
      {...overrides}
    />,
  );
  return { onSelect, onCreate, onDelete };
};

describe('GemScenarioSwitcher', () => {
  it('offers the other scenarios and reports the pick', async () => {
    const { onSelect } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch scenario' }));
    });
    // The scenario on screen is not offered as a destination.
    expect(screen.queryByRole('menuitem', { name: /GEM 12m/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /GEM 6m/ }));
    });

    expect(onSelect).toHaveBeenCalledWith('strategy-2');
  });

  it('hides the switcher until there is somewhere to switch to', () => {
    renderSwitcher({ scenarios: [twoScenarios[0]] });

    expect(screen.queryByRole('button', { name: 'Switch scenario' })).toBeNull();
    // Creating one is still offered; that is how the second comes to exist.
    expect(screen.getByRole('button', { name: 'New scenario' })).toBeInTheDocument();
  });

  it('creates a scenario with the typed name, trimmed', async () => {
    const { onCreate } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New scenario' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Scenario name'), {
        target: { value: '  IKZE quarterly  ' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });

    expect(onCreate).toHaveBeenCalledWith('IKZE quarterly');
  });

  it('warns that deleting takes the evaluation history with it', async () => {
    const { onDelete } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete scenario' }));
    });
    expect(screen.getByText(/whole evaluation history/)).toBeInTheDocument();
    expect(screen.getByText(/GEM 12m/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Delete scenario' }).at(-1) as HTMLElement,
      );
    });
    expect(onDelete).toHaveBeenCalledWith('strategy-1');
  });

  it('never offers to delete the last scenario', () => {
    renderSwitcher({ scenarios: [twoScenarios[0]] });

    // Deleting it would leave nothing to report on; clearing it is the way out.
    expect(screen.queryByRole('button', { name: 'Delete scenario' })).toBeNull();
  });

  it('locks the controls while a scenario call is in flight', () => {
    renderSwitcher({ busy: true });

    expect(screen.getByRole('button', { name: 'New scenario' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete scenario' })).toBeDisabled();
  });
});
