'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createScannerClient,
  type ScannerClient,
  type WorkerFactory,
} from '@/lib/document-scanner/document-scan-client';
import { decodeImageFile } from '@/lib/document-scanner/decode-image';
import type {
  Quad,
  RawImage,
  ScanResult,
} from '@/lib/document-scanner/document-scan.types';

/**
 * Owns the scanner worker for as long as a dialog is open, and makes sure the
 * result on screen belongs to the photo currently on screen.
 *
 * The client already drops replies to requests it has forgotten; this adds the
 * half only the UI knows about -- which request is the CURRENT one. A user who
 * retakes a photo while the first scan is still running has two in flight, and
 * the first one's answer, arriving second, would otherwise replace the second
 * one's preview with the wrong document (`I6`).
 */

export type ScannerStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface DocumentScannerState {
  status: ScannerStatus;
  /** The decoded photo the current result was produced from. */
  source: RawImage | null;
  result: ScanResult | null;
  error: string | null;
  /**
   * A re-warp is running over the result currently on screen.
   *
   * Distinct from `status: 'loading'`, which means there is nothing to show
   * yet: here the previous scan is still valid and displayed, and only the
   * corners have moved.
   */
  recomputing: boolean;
}

export interface UseDocumentScanner extends DocumentScannerState {
  /** Decode a picked file and scan it. */
  scan(file: File): Promise<void>;
  /** Re-warp the current photo with corners the user moved. */
  rewarp(quad: Quad): Promise<void>;
  /** Forget the current photo and result, leaving the worker alive. */
  reset(): void;
}

export function useDocumentScanner(
  createWorker?: WorkerFactory,
): UseDocumentScanner {
  const clientRef = useRef<ScannerClient | null>(null);
  const sourceRef = useRef<RawImage | null>(null);
  /**
   * Which attempt is current. Incremented by every scan and every reset, so a
   * reply captured under an older value is known to be stale without needing
   * to know why it is stale.
   */
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  /**
   * The newest corners waiting to be re-warped, and whether one is running.
   *
   * A re-warp takes seconds on a large photo, so several quick adjustments
   * would otherwise queue behind each other and the user would wait for every
   * intermediate result they had already replaced. Only the newest is kept:
   * the one in flight finishes, then the latest pending corners run, and
   * anything in between is dropped unrun.
   */
  const pendingQuadRef = useRef<Quad | null>(null);
  const rewarpRunningRef = useRef(false);

  const [state, setState] = useState<DocumentScannerState>({
    status: 'idle',
    source: null,
    result: null,
    error: null,
    recomputing: false,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const client = useCallback((): ScannerClient => {
    if (!clientRef.current) {
      clientRef.current = createScannerClient(createWorker);
    }
    return clientRef.current;
  }, [createWorker]);

  /** Apply an update only if the attempt that produced it is still current. */
  const commit = useCallback(
    (attempt: number, next: Partial<DocumentScannerState>): void => {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setState((previous) => ({ ...previous, ...next }));
    },
    [],
  );

  const scan = useCallback(
    async (file: File): Promise<void> => {
      const attempt = ++attemptRef.current;
      // A new photo abandons any adjustment queued for the previous one.
      pendingQuadRef.current = null;
      setState({
        status: 'loading',
        source: null,
        result: null,
        error: null,
        recomputing: false,
      });
      try {
        const image = await decodeImageFile(file);
        if (attempt !== attemptRef.current) return;
        sourceRef.current = image;
        const result = await client().scan(image);
        commit(attempt, {
          status: 'ready',
          source: image,
          result,
          error: null,
        });
      } catch (error) {
        commit(attempt, {
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'The document could not be scanned',
        });
      }
    },
    [client, commit],
  );

  const rewarp = useCallback(
    async (quad: Quad): Promise<void> => {
      const image = sourceRef.current;
      if (!image) return;

      pendingQuadRef.current = quad;
      // Someone is already draining the queue; it will pick this up.
      if (rewarpRunningRef.current) return;
      rewarpRunningRef.current = true;

      try {
        while (pendingQuadRef.current) {
          const next = pendingQuadRef.current;
          pendingQuadRef.current = null;
          // Deliberately NOT a new attempt: a re-warp refines the photo already
          // on screen, so a scan of a different photo landing meanwhile wins.
          const attempt = attemptRef.current;
          commit(attempt, { recomputing: true });
          try {
            const result = await client().rewarp(image, next);
            commit(attempt, { status: 'ready', result, error: null });
          } catch (error) {
            commit(attempt, {
              status: 'failed',
              error:
                error instanceof Error
                  ? error.message
                  : 'The document could not be scanned',
            });
          }
        }
      } finally {
        // Released on every path: leaving it set would strand every later
        // adjustment in the queue with nothing draining it.
        rewarpRunningRef.current = false;
        commit(attemptRef.current, { recomputing: false });
      }
    },
    [client, commit],
  );

  const reset = useCallback((): void => {
    attemptRef.current++;
    sourceRef.current = null;
    pendingQuadRef.current = null;
    setState({
      status: 'idle',
      source: null,
      result: null,
      error: null,
      recomputing: false,
    });
  }, []);

  return { ...state, scan, rewarp, reset };
}
