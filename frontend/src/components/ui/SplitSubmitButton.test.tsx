import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SplitSubmitButton } from './SplitSubmitButton';

const OPTIONS = [
  { id: 'close', label: 'Create Transaction', description: 'Save and close.' },
  { id: 'new', label: 'Create Transaction & New', description: 'Save and start another.' },
] as const;

function renderButton(
  overrides: Partial<React.ComponentProps<typeof SplitSubmitButton>> = {},
  onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault()),
) {
  const props = {
    options: OPTIONS,
    selectedId: 'close',
    onSelect: vi.fn(),
    optionsLabel: 'Choose what happens after creating',
    ...overrides,
  };
  const utils = render(
    <form onSubmit={onSubmit}>
      <SplitSubmitButton {...props} />
    </form>,
  );
  return { ...utils, props, onSubmit };
}

describe('SplitSubmitButton', () => {
  it('labels the button with the selected option', () => {
    renderButton({ selectedId: 'new' });
    expect(screen.getByRole('button', { name: 'Create Transaction & New' })).toBeInTheDocument();
  });

  it('falls back to the first option when the selected id is unknown', () => {
    renderButton({ selectedId: 'nonsense' });
    expect(screen.getByRole('button', { name: 'Create Transaction' })).toBeInTheDocument();
  });

  it('submits the form when the labelled half is clicked', () => {
    const { onSubmit } = renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps the menu closed until the chevron is clicked', () => {
    renderButton();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose what happens after creating' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Save and start another.')).toBeInTheDocument();
  });

  it('opening the menu does not submit the form', () => {
    // The chevron sits inside the form; left as a default-type button it would
    // post the transaction the user only meant to configure.
    const { onSubmit } = renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Choose what happens after creating' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('selecting an option changes the behaviour without submitting', () => {
    const onSelect = vi.fn();
    const { onSubmit } = renderButton({ onSelect });
    fireEvent.click(screen.getByRole('button', { name: 'Choose what happens after creating' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Create Transaction & New/ }));

    expect(onSelect).toHaveBeenCalledWith('new');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks the selected row as checked', () => {
    renderButton({ selectedId: 'new' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose what happens after creating' }));
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('closes on a click outside', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Choose what happens after creating' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape without letting the surrounding modal see it', () => {
    // Modal listens for Escape on `document` and closes the whole form. The
    // menu's own listener runs in the capture phase and stops the event, so
    // dismissing the menu cannot take the half-entered transaction with it.
    const modalEscape = vi.fn();
    document.addEventListener('keydown', modalEscape);
    try {
      renderButton();
      const chevron = screen.getByRole('button', { name: 'Choose what happens after creating' });
      fireEvent.click(chevron);
      // Dispatched on the focused control, the way a real keypress arrives:
      // document's capture listener runs before its bubble listener.
      fireEvent.keyDown(chevron, { key: 'Escape' });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(modalEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', modalEscape);
    }
  });

  it('lets Escape through while the menu is closed', () => {
    const modalEscape = vi.fn();
    document.addEventListener('keydown', modalEscape);
    try {
      renderButton();
      fireEvent.keyDown(
        screen.getByRole('button', { name: 'Choose what happens after creating' }),
        { key: 'Escape' },
      );
      expect(modalEscape).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', modalEscape);
    }
  });

  it('disables both halves while submitting', () => {
    renderButton({ isSubmitting: true });
    expect(screen.getByRole('button', { name: 'Choose what happens after creating' })).toBeDisabled();
    expect(
      screen.getByText('Create Transaction').closest('button'),
    ).toBeDisabled();
  });

  it('keeps the chevron outside the submit button', () => {
    // A control nested in a <button> truncates the click target and breaks
    // hydration; the two halves have to be siblings.
    const { container } = renderButton();
    const submit = container.querySelector('button[type="submit"]')!;
    expect(submit.querySelector('button')).toBeNull();
  });
});
