import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('calls onSort with this field when clicked', () => {
    const { onSort } = renderHeader();
    fireEvent.click(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name');
  });
});
