import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHideOnScroll } from './useHideOnScroll';

/**
 * Drives the window scroll position and flushes the rAF the hook schedules.
 */
function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    // The hook batches its read through requestAnimationFrame.
    vi.runOnlyPendingTimers();
  });
}

describe('useHideOnScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Make requestAnimationFrame run via the fake timer queue.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts visible', () => {
    const { result } = renderHook(() => useHideOnScroll());
    expect(result.current).toBe(false);
  });

  it('hides when scrolling down past the reveal offset', () => {
    const { result } = renderHook(() => useHideOnScroll());
    scrollTo(200);
    expect(result.current).toBe(true);
  });

  it('reveals again when scrolling back up', () => {
    const { result } = renderHook(() => useHideOnScroll());
    scrollTo(200);
    expect(result.current).toBe(true);
    scrollTo(120);
    expect(result.current).toBe(false);
  });

  it('does not hide while still near the top, even scrolling down', () => {
    const { result } = renderHook(() => useHideOnScroll({ revealOffset: 64 }));
    scrollTo(40);
    expect(result.current).toBe(false);
  });

  it('ignores scroll deltas smaller than the threshold', () => {
    const { result } = renderHook(() => useHideOnScroll({ threshold: 50 }));
    scrollTo(200);
    expect(result.current).toBe(true);
    // A tiny upward nudge below the threshold must not flip it back.
    scrollTo(180);
    expect(result.current).toBe(true);
  });

  it('respects a custom reveal offset', () => {
    const { result } = renderHook(() => useHideOnScroll({ revealOffset: 300 }));
    scrollTo(250);
    expect(result.current).toBe(false);
    scrollTo(400);
    expect(result.current).toBe(true);
  });

  it('removes the scroll listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useHideOnScroll());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
