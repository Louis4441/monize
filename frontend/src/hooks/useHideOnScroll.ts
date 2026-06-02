'use client';

import { useState, useEffect, useRef } from 'react';

interface UseHideOnScrollOptions {
  /**
   * Minimum scroll delta (px) before the direction is acted on. Filters out
   * jitter and trackpad/overscroll bounce. Default 8.
   */
  threshold?: number;
  /**
   * The header stays visible while the page is scrolled above this offset (px),
   * so it never hides near the very top. Default 64 (the header height).
   */
  revealOffset?: number;
}

/**
 * Tracks scroll direction and returns whether a sticky header should be hidden.
 *
 * Scrolling down (past `revealOffset`) hides the header; scrolling up reveals
 * it again. Reads are batched through requestAnimationFrame and the scroll
 * listener is passive to keep scrolling smooth.
 *
 * @returns `true` when the header should be slid out of view.
 */
export function useHideOnScroll({
  threshold = 8,
  revealOffset = 64,
}: UseHideOnScrollOptions = {}): boolean {
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    lastScrollY.current = window.scrollY;
    let ticking = false;

    const update = () => {
      ticking = false;
      const currentY = Math.max(0, window.scrollY);
      const delta = currentY - lastScrollY.current;

      if (Math.abs(delta) < threshold) {
        return;
      }

      // Hide when scrolling down past the reveal offset; show when scrolling up
      // or when back near the top.
      setHidden(delta > 0 && currentY > revealOffset);
      lastScrollY.current = currentY;
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold, revealOffset]);

  return hidden;
}
