import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@/test/render';

import { useImageZoom } from './useImageZoom';

const WIDTH = 200;
const HEIGHT = 100;

/** A pointer/wheel event whose frame sits at the viewport origin. */
function makeEvent(
  overrides: Partial<{
    clientX: number;
    clientY: number;
    deltaY: number;
    pointerId: number;
  }> = {},
) {
  const capture = { held: new Set<number>() };
  return {
    clientX: overrides.clientX ?? 0,
    clientY: overrides.clientY ?? 0,
    deltaY: overrides.deltaY ?? 0,
    pointerId: overrides.pointerId ?? 1,
    preventDefault: vi.fn(),
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }),
      setPointerCapture: (id: number) => capture.held.add(id),
      releasePointerCapture: (id: number) => capture.held.delete(id),
      hasPointerCapture: (id: number) => capture.held.has(id),
    },
  } as never;
}

function setup() {
  return renderHook(() => useImageZoom(WIDTH, HEIGHT));
}

describe('useImageZoom', () => {
  it('starts unmagnified', () => {
    const { result } = setup();
    expect(result.current.scale).toBe(1);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.contentStyle.transform).toContain('scale(1)');
  });

  it('magnifies on a wheel up and shrinks back to 1x on wheel down', () => {
    const { result } = setup();

    act(() => result.current.containerProps.onWheel(makeEvent({ deltaY: -1 })));
    expect(result.current.scale).toBeGreaterThan(1);
    expect(result.current.zoomed).toBe(true);

    // Enough wheel-down snaps back to exactly 1x with the transform reset.
    for (let i = 0; i < 10; i++) {
      act(() => result.current.containerProps.onWheel(makeEvent({ deltaY: 1 })));
    }
    expect(result.current.scale).toBe(1);
    expect(result.current.contentStyle.transform).toBe(
      'translate(0px, 0px) scale(1)',
    );
  });

  it('toggles magnification on a double tap and back again', () => {
    const { result } = setup();
    const tap = () =>
      act(() =>
        result.current.containerProps.onPointerDown(makeEvent({ clientX: 100, clientY: 50 })),
      );

    tap();
    tap();
    expect(result.current.scale).toBeGreaterThan(1);

    tap();
    tap();
    expect(result.current.scale).toBe(1);
  });

  it('reset returns to 1x', () => {
    const { result } = setup();
    act(() => result.current.containerProps.onWheel(makeEvent({ deltaY: -1 })));
    expect(result.current.zoomed).toBe(true);

    act(() => result.current.reset());
    expect(result.current.scale).toBe(1);
    expect(result.current.zoomed).toBe(false);
  });

  it('pans only while magnified, and never past the edge', () => {
    const { result } = setup();

    // At 1x a drag does nothing: the offset stays put so an overlay owns it.
    act(() =>
      result.current.containerProps.onPointerDown(makeEvent({ clientX: 100, clientY: 50 })),
    );
    act(() =>
      result.current.containerProps.onPointerMove(makeEvent({ clientX: 40, clientY: 50 })),
    );
    expect(result.current.contentStyle.transform).toContain('translate(0px, 0px)');

    // Magnify, then drag: the image pans, clamped so it still covers the frame.
    for (let i = 0; i < 6; i++) {
      act(() => result.current.containerProps.onWheel(makeEvent({ deltaY: -1, clientX: 100, clientY: 50 })));
    }
    const scale = result.current.scale;
    act(() =>
      result.current.containerProps.onPointerDown(makeEvent({ clientX: 100, clientY: 50, pointerId: 2 })),
    );
    act(() =>
      result.current.containerProps.onPointerMove(makeEvent({ clientX: 300, clientY: 50, pointerId: 2 })),
    );
    // Dragging right cannot pull the left edge past 0.
    const match = /translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/.exec(
      result.current.contentStyle.transform as string,
    );
    const x = Number(match![1]);
    expect(x).toBeLessThanOrEqual(0);
    expect(x).toBeGreaterThanOrEqual(WIDTH - scale * WIDTH);
  });
});
