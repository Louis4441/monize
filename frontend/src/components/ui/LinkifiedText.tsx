'use client';

import { Fragment, type MouseEvent, type TouchEvent } from 'react';
import { linkifySegments } from '@/lib/linkify';

/**
 * User-authored text with the web addresses in it drawn as links.
 *
 * This is the ONLY way a stored description or memo becomes clickable. It
 * renders text nodes and anchors -- never markup from the string itself -- so
 * the field stays plain text end to end: nothing is stored as HTML, no
 * sanitizer is relaxed, and the codebase's zero `dangerouslySetInnerHTML` count
 * is unchanged. What the reader sees is byte-for-byte what the writer typed;
 * only the affordance is new. `linkify.ts` holds that round trip as a test.
 *
 * No wrapper element: the caller's cell already carries the truncation, colour
 * and line-through this text is styled with, and a `<div>` of our own would
 * break `truncate` on the parent.
 */

interface LinkifiedTextProps {
  /** The stored text. A caller with nothing to show renders its own fallback. */
  text: string;
}

/**
 * A register row is clickable (`useLongPress`), so an anchor inside one is a
 * control inside a row and follows the same rule as the favourite star and
 * `RowActions`: it stops the event rather than letting the row act on it.
 * Without this a tap on the link both opened the ticket page and the edit
 * modal behind it, and a press-and-hold opened the mobile action sheet on top
 * of the browser's own link menu.
 */
function stopRowActivation(event: MouseEvent | TouchEvent) {
  event.stopPropagation();
}

export function LinkifiedText({ text }: LinkifiedTextProps) {
  const segments = linkifySegments(text);

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stopRowActivation}
            onMouseDown={stopRowActivation}
            onTouchStart={stopRowActivation}
            onContextMenu={stopRowActivation}
            className="text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm dark:text-blue-400"
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={index}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}
