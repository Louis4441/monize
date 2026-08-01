import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('renders tooltip text', () => {
    render(<InfoTooltip text="Help text here" />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text here');
  });

  it('exposes the text via aria-label without a native title', () => {
    render(<InfoTooltip text="Helpful info" />);
    const span = screen.getByLabelText('Helpful info');
    expect(span).toHaveAttribute('aria-label', 'Helpful info');
    expect(span).not.toHaveAttribute('title');
  });

  it('applies bottom placement classes by default', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('top-full');
  });

  it('applies top placement classes when placement is top', () => {
    render(<InfoTooltip text="Tooltip" placement="top" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('bottom-full');
  });

  it('anchors the popover to the right edge when align is right', () => {
    render(<InfoTooltip text="Tooltip" align="right" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('right-0');
    expect(tooltipEl.className).not.toContain('left-0');
  });

  it('keeps the default left anchor for bottom placement', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('left-0');
    expect(tooltipEl.className).not.toContain('right-0');
  });

  it('applies custom icon className', () => {
    const { container } = render(<InfoTooltip text="Tooltip" iconClassName="h-6 w-6" />);
    expect(container.querySelector('.h-6.w-6')).toBeInTheDocument();
  });

  it('is reachable by keyboard and reveals the popover on focus', () => {
    render(<InfoTooltip text="Keyboard help" />);
    const trigger = screen.getByLabelText('Keyboard help');
    expect(trigger.tagName).toBe('BUTTON');
    expect(screen.getByRole('tooltip').className).toContain('group-focus/tip:block');
  });

  it('is a button, not a focusable span', () => {
    // A span's implicit role is generic: screen readers skip it and drop its
    // aria-label, so a tabIndex on one is a tab stop that announces nothing.
    // The trigger is announced as a button, and never submits its form.
    render(<InfoTooltip text="Named help" />);
    const trigger = screen.getByRole('button', { name: 'Named help' });
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).not.toHaveAttribute('tabindex');
  });

  it('dismisses the popover on Escape and re-arms on the next focus', () => {
    render(<InfoTooltip text="Escapable" />);
    const trigger = screen.getByRole('button', { name: 'Escapable' });

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.getByRole('tooltip').className).not.toContain(
      'group-focus/tip:block',
    );

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip').className).toContain(
      'group-focus/tip:block',
    );
  });

  it('opens and closes the portal popover on focus and blur', () => {
    render(<InfoTooltip text="Portal help" usePortal />);
    const trigger = screen.getByRole('button', { name: 'Portal help' });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Portal help');

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses the portal popover on Escape', () => {
    render(<InfoTooltip text="Portal escape" usePortal />);
    const trigger = screen.getByRole('button', { name: 'Portal escape' });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
