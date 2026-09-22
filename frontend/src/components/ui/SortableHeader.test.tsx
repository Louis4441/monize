import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SortableHeader } from './SortableHeader';

function renderHeader(props: Partial<Parameters<typeof SortableHeader>[0]> = {}) {
  const onSort = vi.fn();
  const utils = render(
    <table>
      <thead>
        <tr>
          <SortableHeader<'name' | 'amount'>
            field="name"
            sortField="name"
            sortDirection="asc"
            onSort={onSort}
            {...(props as any)}
          >
            Name
          </SortableHeader>
        </tr>
      </thead>
    </table>,
  );
  return { ...utils, onSort };
}

describe('SortableHeader', () => {
  it('renders the children label', () => {
    renderHeader();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('shows ascending indicator when sorted asc on this field', () => {
    renderHeader({ sortDirection: 'asc' });
    expect(screen.getByText('↑')).toBeInTheDocument();
  });

  it('shows descending indicator when sorted desc on this field', () => {
    renderHeader({ sortDirection: 'desc' });
    expect(screen.getByText('↓')).toBeInTheDocument();
  });

  it('shows neutral indicator when sorted by a different field', () => {
    renderHeader({ sortField: 'amount' });
    expect(screen.getByText('↕')).toBeInTheDocument();
  });

  it('exposes only the active direction and hides the visual glyph', () => {
    const { rerender } = renderHeader({ sortDirection: 'desc' });
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByText('↓')).toHaveAttribute('aria-hidden', 'true');

    rerender(
      <table>
        <thead>
          <tr>
            <SortableHeader<'name' | 'amount'>
              field="name"
              sortField="amount"
              sortDirection="asc"
              onSort={vi.fn()}
            >
              Name
            </SortableHeader>
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
  });

  it('calls onSort with this field when clicked', () => {
    const { onSort } = renderHeader();
    fireEvent.click(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it.each(['Enter', ' '])('sorts from the keyboard with %j', (key) => {
    const { onSort } = renderHeader();
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(header, { key });

    expect(onSort).toHaveBeenCalledOnce();
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('ignores unrelated keys', () => {
    const { onSort } = renderHeader();
    fireEvent.keyDown(screen.getByRole('columnheader', { name: 'Name' }), { key: 'ArrowDown' });
    expect(onSort).not.toHaveBeenCalled();
  });
});

describe('SortableHeader controls slot', () => {
  it('does not sort when the control inside the header is used', () => {
    // The register's Date header hosts the year toggle. Before the slot
    // existed, every use of that toggle also re-sorted the column.
    const onSort = vi.fn();
    const onToggle = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader
              field="date"
              sortField="date"
              sortDirection="desc"
              onSort={onSort}
              controls={
                <button type="button" onClick={onToggle}>
                  Hide the year
                </button>
              }
            >
              Date
            </SortableHeader>
          </tr>
        </thead>
      </table>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSort).not.toHaveBeenCalled();
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');

    // Keyboard activation of the control is the same decision.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hide the year' }), { key: 'Enter' });
    expect(onSort).not.toHaveBeenCalled();

    // The header itself still sorts.
    fireEvent.click(screen.getByRole('columnheader'));
    expect(onSort).toHaveBeenCalledWith('date');
  });
});
