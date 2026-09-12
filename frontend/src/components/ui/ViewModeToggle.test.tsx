import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ViewModeToggle } from './ViewModeToggle';
import calendarNs from '@/i18n/messages/en/calendar.json';

describe('ViewModeToggle', () => {
  it('marks the current view pressed and the other not', () => {
    render(<ViewModeToggle value="calendar" onChange={() => {}} />);

    expect(screen.getByRole('button', { name: calendarNs.view.calendar })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: calendarNs.view.table })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('reports the view the reader picked', () => {
    const onChange = vi.fn();
    render(<ViewModeToggle value="table" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: calendarNs.view.calendar }));

    expect(onChange).toHaveBeenCalledWith('calendar');
  });

  it('names the group, so the two buttons are read as one control', () => {
    render(<ViewModeToggle value="table" onChange={() => {}} />);
    expect(screen.getByRole('group', { name: calendarNs.view.label })).toBeInTheDocument();
  });
});
