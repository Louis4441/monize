import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { PdfPages } from './PdfPages';
import { openPdf } from '@/lib/attachment-preview/pdf-engine';

vi.mock('@/lib/attachment-preview/pdf-engine', () => ({
  openPdf: vi.fn(),
}));

const mockOpen = openPdf as ReturnType<typeof vi.fn>;
const OriginalResizeObserver = globalThis.ResizeObserver;

/** Reports a 600px-wide container as soon as it is observed. */
class WideResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 600 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function handleOf(numPages: number) {
  const renderPage = vi.fn(
    (_page: number, _canvas: HTMLCanvasElement, _width: number, _ratio: number) => ({
      done: Promise.resolve(),
      cancel: vi.fn(),
    }),
  );
  const destroy = vi.fn(() => Promise.resolve());
  return { numPages, renderPage, destroy };
}

describe('PdfPages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = WideResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  const bytes = new Uint8Array([1, 2, 3]).buffer;

  it('draws one labelled canvas per page, in order, at the container width', async () => {
    const handle = handleOf(2);
    mockOpen.mockResolvedValue(handle);
    await act(async () => {
      render(<PdfPages bytes={bytes} label="invoice.pdf" />);
    });

    expect(mockOpen).toHaveBeenCalledWith(bytes);
    expect(screen.getByText('2 pages')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();

    await waitFor(() => expect(handle.renderPage).toHaveBeenCalledTimes(2));
    expect(handle.renderPage.mock.calls[0][0]).toBe(1);
    expect(handle.renderPage.mock.calls[1][0]).toBe(2);
    expect(handle.renderPage.mock.calls[0][2]).toBe(600);
  });

  it('shows the loading state until the document opens', async () => {
    mockOpen.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<PdfPages bytes={bytes} label="invoice.pdf" />);
    });
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('destroys the document on unmount', async () => {
    const handle = handleOf(1);
    mockOpen.mockResolvedValue(handle);
    let unmount: () => void = () => {};
    await act(async () => {
      ({ unmount } = render(<PdfPages bytes={bytes} label="invoice.pdf" />));
    });
    await waitFor(() => expect(handle.renderPage).toHaveBeenCalled());
    unmount();
    expect(handle.destroy).toHaveBeenCalled();
  });

  it('reports a document it cannot open, rather than an empty one', async () => {
    mockOpen.mockRejectedValue(new Error('bad pdf'));
    await act(async () => {
      render(<PdfPages bytes={bytes} label="invoice.pdf" />);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The preview could not be loaded',
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
