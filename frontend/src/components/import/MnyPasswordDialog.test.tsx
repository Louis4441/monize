import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyPasswordDialog } from './MnyPasswordDialog';

describe('MnyPasswordDialog', () => {
  const defaultProps = {
    isOpen: true,
    isRetry: false,
    isLoading: false,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('says the password is used once and never stored', () => {
    render(<MnyPasswordDialog {...defaultProps} />);

    expect(screen.getByText(/never stored/)).toBeInTheDocument();
  });

  it('says something different when the password was already rejected', () => {
    render(<MnyPasswordDialog {...defaultProps} isRetry />);

    // "this file needs a password" and "that password is wrong" are different
    // problems for the person typing.
    expect(
      screen.getByText(/That password did not open the file/),
    ).toBeInTheDocument();
  });

  it('submits the password that was typed', () => {
    render(<MnyPasswordDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('Money file password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));

    expect(defaultProps.onSubmit).toHaveBeenCalledWith('hunter2');
  });

  it('will not submit an empty password', () => {
    render(<MnyPasswordDialog {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Open file' })).toBeDisabled();
  });

  it('masks the password by default', () => {
    render(<MnyPasswordDialog {...defaultProps} />);

    expect(screen.getByLabelText('Money file password')).toHaveAttribute(
      'type',
      'password',
    );
  });

  it('cancels', () => {
    render(<MnyPasswordDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(<MnyPasswordDialog {...defaultProps} isOpen={false} />);

    expect(
      screen.queryByText(/This Money file needs a password/),
    ).not.toBeInTheDocument();
  });
});
