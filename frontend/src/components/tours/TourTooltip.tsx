'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import {
  computeTooltipPosition,
  type Rect,
  type Size,
} from '@/lib/tours/positioning';
import type { TourPlacement } from '@/lib/tours/types';

/** `[label](https://…)` -- the only link form tour copy needs. */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Render a tour string: **bold** segments, and `[label](url)` links out to the
 * wiki. Deliberately tiny -- the only markup tour copy needs -- so bodies stay
 * plain strings (no next-intl rich text, and the markers survive pseudo-locale
 * generation untouched).
 *
 * Links are restricted to http(s) by the pattern itself, so a translated string
 * can never smuggle in a `javascript:` target, and they open in a new tab: a
 * tour that navigated away would be dismissed by its own copy.
 */
function renderTourText(text: string): ReactNode {
  const segments: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const pushEmphasised = (chunk: string) => {
    if (!chunk) return;
    chunk.split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
      if (!part) return;
      segments.push(
        i % 2 === 1 ? (
          <strong
            key={`s${key++}`}
            className="font-semibold text-gray-900 dark:text-gray-100"
          >
            {part}
          </strong>
        ) : (
          <Fragment key={`s${key++}`}>{part}</Fragment>
        ),
      );
    });
  };

  LINK.lastIndex = 0;
  let match = LINK.exec(text);
  while (match) {
    pushEmphasised(text.slice(cursor, match.index));
    segments.push(
      <a
        key={`s${key++}`}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {match[1]}
      </a>,
    );
    cursor = match.index + match[0].length;
    match = LINK.exec(text);
  }
  pushEmphasised(text.slice(cursor));

  return segments;
}

export interface TourTooltipLabels {
  next: string;
  back: string;
  done: string;
  endTour: string;
  tryIt: string;
  skipStep: string;
  move: string;
}

/** Keyboard nudge distance for the move handle, in px. */
const NUDGE = 24;
/** Minimum gap kept between the card and the viewport edges. */
const EDGE = 8;

interface TourTooltipProps {
  /** Anchor rect, or null for a centered card. */
  rect: Rect | null;
  placement?: TourPlacement;
  title: string;
  body: string;
  /** e.g. "2 of 10". */
  stepLabel: string;
  /** Interactive steps show a "Try it" hint + "Skip this step" instead of Next. */
  interactive: boolean;
  /** Park an anchorless card in the bottom-right corner instead of centering
   *  it, so the page behind stays readable and usable. Ignored when `rect` is
   *  set (anchored cards position against the anchor) and on mobile (where the
   *  card is a bottom sheet already). */
  corner?: boolean;
  /** Last step (or the skipped outro): the primary button is Done, not Next. */
  isLast: boolean;
  canBack: boolean;
  reducedMotion: boolean;
  /** In-form steps keep focus with the form rather than stealing it. */
  leaveFocusToForm: boolean;
  onNext: () => void;
  /** Primary action on the last step / skipped outro. */
  onDone: () => void;
  onBack: () => void;
  onSkip: () => void;
  onEnd: () => void;
  labels: TourTooltipLabels;
}

const MOBILE_QUERY = '(max-width: 639px)';

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

/**
 * The anchored (or centered) tour card. Positioned with the pure
 * `computeTooltipPosition` after measuring its own size on first paint, like
 * CalendarPopover. Not a `Modal` (its focus trap and scroll lock are wrong for
 * a walkthrough): on desktop it moves focus to itself on each passive step so
 * the controls are keyboard-reachable and `Modal` yields Esc/Tab to it; the
 * only exception is in-form steps, where focus stays with the form. On mobile
 * it renders as a fixed bottom sheet.
 */
export function TourTooltip({
  rect,
  placement = 'auto',
  title,
  body,
  stepLabel,
  corner = false,
  interactive,
  isLast,
  canBack,
  reducedMotion,
  leaveFocusToForm,
  onNext,
  onDone,
  onBack,
  onSkip,
  onEnd,
  labels,
}: TourTooltipProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [size, setSize] = useState<Size | null>(null);
  // Where the user dragged the card, if they moved it. Null = auto-positioned.
  const [movedTo, setMovedTo] = useState<{ top: number; left: number } | null>(
    null,
  );
  const dragFrom = useRef<{
    x: number;
    y: number;
    top: number;
    left: number;
  } | null>(null);

  // A manual position belongs to the step it was set on: the next step points
  // at something else, so it re-positions itself ("info from previous render",
  // never a setState in an effect).
  const stepKey = `${stepLabel}|${title}`;
  const [prevStepKey, setPrevStepKey] = useState(stepKey);
  if (stepKey !== prevStepKey) {
    setPrevStepKey(stepKey);
    setMovedTo(null);
  }

  // Measure the card after first paint so positioning can center/flip it.
  useEffect(() => {
    if (!cardRef.current) return;
    const el = cardRef.current;
    const raf = requestAnimationFrame(() => {
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    });
    return () => cancelAnimationFrame(raf);
  }, [title, body, isMobile]);

  // Move focus to the card on each step so its controls are keyboard-reachable
  // and Modal (which traps Tab) yields to us -- unless an in-form step asked us
  // to leave focus with the form.
  useEffect(() => {
    if (leaveFocusToForm || isMobile) return;
    const raf = requestAnimationFrame(() => cardRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [title, leaveFocusToForm, isMobile]);

  const primaryLabel = isLast ? labels.done : labels.next;

  const controls = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onEnd}
        className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        {labels.endTour}
      </button>
      <div className="flex items-center gap-2">
        {canBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            {labels.back}
          </Button>
        )}
        {interactive ? (
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {labels.skipStep}
          </button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={isLast ? onDone : onNext}
          >
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );

  const cardBody = (
    <>
      <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
        {stepLabel}
      </p>
      <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        {renderTourText(body)}
      </p>
      {interactive && (
        <p className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {labels.tryIt}
        </p>
      )}
      {controls}
    </>
  );

  if (isMobile) {
    return createPortal(
      <div
        ref={cardRef}
        role="dialog"
        aria-live="polite"
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-[70] rounded-t-2xl border-t border-gray-200 bg-white p-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800"
      >
        {cardBody}
      </div>,
      document.body,
    );
  }

  const viewport = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  };
  const tooltipSize = size ?? { width: 320, height: 160 };

  let top: number;
  let left: number;
  if (rect) {
    const pos = computeTooltipPosition(rect, tooltipSize, viewport, placement);
    top = pos.top;
    left = pos.left;
  } else if (corner) {
    // Parked bottom-right so the page stays readable and usable behind it.
    top = Math.max(8, viewport.height - tooltipSize.height - 16);
    left = Math.max(8, viewport.width - tooltipSize.width - 16);
  } else {
    top = Math.max(8, viewport.height / 2 - tooltipSize.height / 2);
    left = Math.max(8, viewport.width / 2 - tooltipSize.width / 2);
  }

  // A step's auto-position can still land over the very thing the user needs
  // (an account row, say), so the card is movable. Once moved, the user's
  // position wins for the rest of the step.
  const clampToViewport = (nextTop: number, nextLeft: number) => ({
    top: Math.min(
      Math.max(EDGE, nextTop),
      Math.max(EDGE, viewport.height - tooltipSize.height - EDGE),
    ),
    left: Math.min(
      Math.max(EDGE, nextLeft),
      Math.max(EDGE, viewport.width - tooltipSize.width - EDGE),
    ),
  });

  const shownTop = movedTo ? movedTo.top : top;
  const shownLeft = movedTo ? movedTo.left : left;

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Stop the press from selecting text or focusing through to the page.
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragFrom.current = {
      x: e.clientX,
      y: e.clientY,
      top: shownTop,
      left: shownLeft,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    setMovedTo(
      clampToViewport(
        from.top + (e.clientY - from.y),
        from.left + (e.clientX - from.x),
      ),
    );
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragFrom.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  };

  // Keyboard equivalent: nudge with the arrow keys while the handle is focused.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    setMovedTo(clampToViewport(shownTop + delta[1], shownLeft + delta[0]));
  };

  // Hide until measured to avoid a first-paint jump (visibility keeps it
  // measurable). Skip the fade for reduced-motion users.
  const measured = size !== null;
  // Suppress the fade while dragging so the card tracks the pointer exactly.
  const transition = reducedMotion ? '' : 'transition-opacity duration-150';

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-live="polite"
      tabIndex={-1}
      className={`fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded-lg border border-gray-200 bg-white p-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800 ${transition} ${
        measured ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ top: shownTop, left: shownLeft }}
    >
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        aria-label={labels.move}
        title={labels.move}
        className="absolute right-1.5 top-1.5 cursor-move touch-none rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
      >
        {/* Six-dot grip */}
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="7" cy="5" r="1.5" />
          <circle cx="13" cy="5" r="1.5" />
          <circle cx="7" cy="10" r="1.5" />
          <circle cx="13" cy="10" r="1.5" />
          <circle cx="7" cy="15" r="1.5" />
          <circle cx="13" cy="15" r="1.5" />
        </svg>
      </button>
      {cardBody}
    </div>,
    document.body,
  );
}
