import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { KeyValueList } from './KeyValueList';

describe('KeyValueList', () => {
  it('renders each label with its value', () => {
    render(
      <KeyValueList
        rows={[
          { key: 'exchange', label: 'Exchange', value: 'NASDAQ' },
          { key: 'currency', label: 'Currency', value: 'USD' },
        ]}
      />,
    );
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('NASDAQ')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('drops rows with no value rather than showing a blank', () => {
    render(
      <KeyValueList
        rows={[
          { key: 'exchange', label: 'Exchange', value: 'NASDAQ' },
          { key: 'isin', label: 'ISIN', value: null },
          { key: 'sector', label: 'Sector', value: undefined },
          { key: 'industry', label: 'Industry', value: '' },
        ]}
      />,
    );
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.queryByText('ISIN')).not.toBeInTheDocument();
    expect(screen.queryByText('Sector')).not.toBeInTheDocument();
    expect(screen.queryByText('Industry')).not.toBeInTheDocument();
  });

  it('keeps a zero value, which is data rather than absence', () => {
    render(<KeyValueList rows={[{ key: 'fees', label: 'Fees', value: 0 }]} />);
    expect(screen.getByText('Fees')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders nothing at all when every row is empty', () => {
    const { container } = render(
      <KeyValueList
        rows={[
          { key: 'isin', label: 'ISIN', value: null },
          { key: 'sector', label: 'Sector', value: '' },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('accepts rendered values such as links', () => {
    render(
      <KeyValueList
        rows={[
          {
            key: 'website',
            label: 'Website',
            value: <a href="https://example.com">example.com</a>,
          },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'example.com' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
  });

  it('marks up the pairs as a description list', () => {
    const { container } = render(
      <KeyValueList rows={[{ key: 'currency', label: 'Currency', value: 'USD' }]} />,
    );
    expect(container.querySelector('dl')).toBeInTheDocument();
    expect(container.querySelector('dt')?.textContent).toBe('Currency');
    expect(container.querySelector('dd')?.textContent).toBe('USD');
  });
});
