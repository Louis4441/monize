import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentReportColumnChooser } from './InvestmentReportColumnChooser';
import { INVESTMENT_REPORT_COLUMNS } from '@/types/investment-report';

describe('InvestmentReportColumnChooser', () => {
  it('always pins symbol first and marks it as locked', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['marketValue']} onChange={onChange} />);
    expect(screen.getByText('(always shown)')).toBeInTheDocument();
    // Symbol appears in the selected list even though it was not passed first
    expect(screen.getByText('Selected columns (2)')).toBeInTheDocument();
  });

  it('adds an available column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Add Market Value'));
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue']);
  });

  it('removes a selected column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove Gain'));
    expect(onChange).toHaveBeenCalledWith(['symbol']);
  });

  it('does not allow removing the symbol column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    expect(screen.queryByLabelText('Remove Symbol')).not.toBeInTheDocument();
  });

  it('reorders columns by dragging one onto another', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser
        value={['symbol', 'gain', 'marketValue']}
        onChange={onChange}
      />,
    );
    const source = screen.getByTestId('selected-marketValue');
    const target = screen.getByTestId('selected-gain');
    fireEvent.dragStart(source);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue', 'gain']);
  });

  it('never places a dragged column before the pinned symbol', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser
        value={['symbol', 'gain', 'name']}
        onChange={onChange}
      />,
    );
    const source = screen.getByTestId('selected-name');
    const target = screen.getByTestId('selected-symbol');
    fireEvent.dragStart(source);
    fireEvent.drop(target);
    // Dropping onto symbol lands just after it; symbol stays first.
    expect(onChange).toHaveBeenCalledWith(['symbol', 'name', 'gain']);
  });

  it('does not reorder when the dragged item is the pinned symbol', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />,
    );
    // Symbol is not draggable, so dragStart sets no source; dropping is a no-op.
    fireEvent.dragStart(screen.getByTestId('selected-symbol'));
    fireEvent.drop(screen.getByTestId('selected-gain'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to the raw key for an unknown selected column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'legacyKey']} onChange={onChange} />);
    // A column key no longer in the catalogue still renders by its key.
    expect(screen.getByText('legacyKey')).toBeInTheDocument();
  });

  it('shows an empty state when every column is selected', () => {
    const onChange = vi.fn();
    const allKeys = INVESTMENT_REPORT_COLUMNS.map((c) => c.key);
    render(<InvestmentReportColumnChooser value={allKeys} onChange={onChange} />);
    expect(screen.getByText('All columns selected')).toBeInTheDocument();
  });
});
