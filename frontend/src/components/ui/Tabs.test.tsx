import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Tabs, TabPanel, tabId, tabPanelId } from './Tabs';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'prices', label: 'Price history' },
] as const;

type Key = (typeof TABS)[number]['key'];

function renderTabs(value: Key = 'overview', onChange = vi.fn()) {
  const result = render(
    <Tabs
      tabs={TABS}
      value={value}
      onChange={onChange}
      idPrefix="security"
      ariaLabel="Security sections"
    />,
  );
  return { ...result, onChange };
}

describe('Tabs', () => {
  it('renders every tab inside a labelled tablist', () => {
    renderTabs();
    const tablist = screen.getByRole('tablist', { name: 'Security sections' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('marks only the selected tab as selected', () => {
    renderTabs('transactions');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('gives the set a single tab stop via roving tabindex', () => {
    renderTabs('transactions');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    expect(screen.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('reports the clicked tab', () => {
    const { onChange } = renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'Price history' }));
    expect(onChange).toHaveBeenCalledWith('prices');
  });

  it('wires each tab to its panel', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-controls',
      tabPanelId('security', 'overview'),
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'id',
      tabId('security', 'overview'),
    );
  });

  describe('keyboard navigation', () => {
    it('moves to the next tab on ArrowRight', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('transactions');
    });

    it('moves to the previous tab on ArrowLeft', () => {
      const { onChange } = renderTabs('transactions');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Transactions' }), {
        key: 'ArrowLeft',
      });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('wraps from the last tab to the first', () => {
      const { onChange } = renderTabs('prices');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Price history' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('wraps from the first tab to the last', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowLeft',
      });
      expect(onChange).toHaveBeenCalledWith('prices');
    });

    it('jumps to the ends on Home and End', () => {
      const { onChange } = renderTabs('transactions');
      const current = screen.getByRole('tab', { name: 'Transactions' });
      fireEvent.keyDown(current, { key: 'End' });
      expect(onChange).toHaveBeenCalledWith('prices');
      fireEvent.keyDown(current, { key: 'Home' });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('moves focus along with the selection', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('transactions');
      expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveFocus();
    });

    it('leaves other keys to the browser', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'a',
      });
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe('TabPanel', () => {
  it('renders its children when active, labelled by its tab', () => {
    render(
      <TabPanel idPrefix="security" tabKey="overview" isActive>
        <p>Panel body</p>
      </TabPanel>,
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', tabPanelId('security', 'overview'));
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      tabId('security', 'overview'),
    );
    expect(screen.getByText('Panel body')).toBeInTheDocument();
  });

  it('renders nothing when inactive, so its content never loads', () => {
    render(
      <TabPanel idPrefix="security" tabKey="overview" isActive={false}>
        <p>Panel body</p>
      </TabPanel>,
    );
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    expect(screen.queryByText('Panel body')).not.toBeInTheDocument();
  });
});
