import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('renders with label', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders without label', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('shows error message', () => {
    render(<Input label="Name" error="Required" />);
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('renders prefix', () => {
    render(<Input label="Amount" prefix="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('uses custom id', () => {
    render(<Input label="Test" id="custom-id" />);
    expect(screen.getByLabelText('Test')).toHaveAttribute('id', 'custom-id');
  });

  it('generates id from label', () => {
    render(<Input label="Full Name" />);
    expect(screen.getByLabelText('Full Name')).toHaveAttribute('id', 'input-full-name');
  });

  it('has displayName', () => {
    expect(Input.displayName).toBe('Input');
  });

  it('toggles password visibility with the eye button', () => {
    render(<Input label="Password" type="password" />);
    const field = screen.getByLabelText('Password');
    expect(field).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show input' });
    fireEvent.click(toggle);
    expect(field).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide input' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('does not render the eye toggle for non-password inputs', () => {
    render(<Input label="Email" type="email" />);
    expect(
      screen.queryByRole('button', { name: /input/i }),
    ).not.toBeInTheDocument();
  });
});
