'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, WheelEvent } from 'react';

/**
 * Pan and zoom for a fixed-size preview, so fine print can be checked before a
 * scan is kept.
 *
 * The image is drawn at the size the dialog gives it and this magnifies that
 * box rather than re-rendering at a higher resolution: it is a viewer control,
 * not a second pipeline, so it never changes the pixels that get stored.
 *
 * The content is transformed from its top-left corner, and the translation is
 * always clamped so the magnified image still covers the frame -- a pan can
 * never expose a strip of background, which reads as the picture having slipped.
 *
 * Interactions are the three every phone gallery uses: double tap (or double
 * click) toggles magnification at the point touched, a drag pans while
 * magnified, and the wheel zooms on a desktop. A single-pointer drag does
 * nothing at 1x, so a caller drawing its own handles over the image keeps them.
 */

/** How far a double tap magnifies, and the ceiling a wheel can reach. */
const DOUBLE_TAP_SCALE = 2.5;
const MAX_SCALE = 4;
/** One wheel notch. */
const WHEEL_STEP = 1.15;
/** Two taps closer together than this in time, and nearer than the slop, double. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export interface ImageZoom {
  /** The current magnification. 1 means untouched. */
  scale: number;
  /** Whether the image is magnified, so a caller can suspend its own gestures. */
  zoomed: boolean;
  /** Return to 1x. Call it when the shown image is replaced. */
  reset: () => void;
  /** Spread on the fixed-size frame: the gesture handlers and clipping. */
  containerProps: {
    onPointerDown: (event: PointerEvent) => void;
    onPointerMove: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onPointerCancel: (event: PointerEvent) => void;
    onWheel: (event: WheelEvent) => void;
    style: CSSProperties;
  };
  /** Spread on the element holding the image (and any overlay): the transform. */
  contentStyle: CSSProperties;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a translation so the scaled content still covers the `size`-wide frame.
 * At scale s the content is `s * size` wide, so the offset runs from
 * `size - s*size` (right/bottom edge flush) to `0` (left/top edge flush).
 */
function clampOffset(offset: number, scale: number, size: number): number {
  return clamp(offset, size - scale * size, 0);
}

/** Magnify to `nextScale` while keeping the frame point (px, py) fixed. */
function zoomToPoint(
  current: Transform,
  nextScale: number,
  px: number,
  py: number,
  width: number,
  height: number,
): Transform {
  const scale = clamp(nextScale, 1, MAX_SCALE);
  if (scale === 1) return IDENTITY;
  // The content point under the cursor stays under it: x2 = px - s*(px - x)/s0.
  const x = px - (scale * (px - current.x)) / current.scale;
  const y = py - (scale * (py - current.y)) / current.scale;
  return {
    scale,
    x: clampOffset(x, scale, width),
    y: clampOffset(y, scale, height),
  };
}

/** `width` and `height` are the frame's size in CSS pixels. */
export function useImageZoom(width: number, height: number): ImageZoom {
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  // Whether the image is magnified, kept in a ref so the pointer-down handler
  // can decide "pan or leave the drag to the overlay" without a stale closure.
  // Updated in an effect rather than during render (the refs lint rule); every
  // pixel computation below reads the live value through a state updater.
  const zoomedRef = useRef(false);
  useEffect(() => {
    zoomedRef.current = transform.scale > 1;
  }, [transform.scale]);

  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => setTransform(IDENTITY), []);

  const pointInFrame = (event: PointerEvent | WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };

  const onWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const { px, py } = pointInFrame(event);
      const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      setTransform((current) =>
        zoomToPoint(current, current.scale * factor, px, py, width, height),
      );
    },
    [width, height],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent) => {
      const { px, py } = pointInFrame(event);
      const last = lastTapRef.current;
      const now = Date.now();
      const isDoubleTap =
        last !== null &&
        now - last.time < DOUBLE_TAP_MS &&
        Math.abs(px - last.x) < DOUBLE_TAP_SLOP &&
        Math.abs(py - last.y) < DOUBLE_TAP_SLOP;

      if (isDoubleTap) {
        lastTapRef.current = null;
        // Toggle: magnify at the point, or return to 1x if already magnified.
        setTransform((current) =>
          current.scale > 1
            ? IDENTITY
            : zoomToPoint(current, DOUBLE_TAP_SCALE, px, py, width, height),
        );
        return;
      }
      lastTapRef.current = { time: now, x: px, y: py };

      // Only a magnified image pans; at 1x the drag belongs to whatever the
      // caller draws over the image (the corner handles).
      if (zoomedRef.current) {
        panRef.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [width, height],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const pan = panRef.current;
      if (!pan) return;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      panRef.current = { x: event.clientX, y: event.clientY };
      setTransform((current) => ({
        scale: current.scale,
        x: clampOffset(current.x + dx, current.scale, width),
        y: clampOffset(current.y + dy, current.scale, height),
      }));
    },
    [width, height],
  );

  const endPan = useCallback((event: PointerEvent) => {
    if (!panRef.current) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const contentStyle = useMemo<CSSProperties>(
    () => ({
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      transformOrigin: '0 0',
      willChange: transform.scale > 1 ? 'transform' : undefined,
    }),
    [transform],
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      // Clip only while magnified. At 1x an overlay may extend past the image
      // on purpose -- the corner handles' targets do -- and must stay visible.
      overflow: transform.scale > 1 ? 'hidden' : 'visible',
      touchAction: 'none',
      cursor: transform.scale > 1 ? 'grab' : undefined,
    }),
    [transform.scale],
  );

  return {
    scale: transform.scale,
    zoomed: transform.scale > 1,
    reset,
    containerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onWheel,
      style: containerStyle,
    },
    contentStyle,
  };
}
