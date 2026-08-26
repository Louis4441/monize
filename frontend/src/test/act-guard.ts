/**
 * Fail a test run on React's act() warnings instead of printing them.
 *
 * An act warning is a test reading a tree React has not finished updating: the
 * assertion sees whatever happened to be committed when it ran, so the test
 * passes or fails on timing rather than on behaviour. They are invisible on a
 * fast machine -- the late update lands inside the act scope and nothing is
 * printed -- and surface on a loaded CI runner, which is the one place nobody
 * is watching stderr. CI run #2873 carried fifteen of them under a green tick.
 *
 * Fix the update, never the symptom: await the thing that lands late
 * (`await screen.findBy...`, `await waitFor(...)`), or wrap the trigger in
 * `await act(async () => { ... })`. Filtering the message back out would only
 * restore the silence this exists to remove.
 *
 * Wired in `setup.ts`; `act-guard.test.ts` checks both this behaviour and that
 * the wiring is still there.
 */
const ACT_WARNING = /not wrapped in act|not configured to support act/;

const warnings: string[] = [];

/** True when `console.error`'s arguments are one of React's act warnings. */
export function isActWarning(args: readonly unknown[]): boolean {
  return typeof args[0] === 'string' && ACT_WARNING.test(args[0]);
}

/**
 * Record one warning. React formats these printf-style ("An update to %s ..."),
 * so the component name arrives as a separate argument -- interpolate it, or
 * the report names no component at all.
 */
export function recordActWarning(args: readonly unknown[]): void {
  const template = typeof args[0] === 'string' ? args[0] : '';
  let i = 1;
  const formatted = template.replace(/%[sdifoOc]/g, () => String(args[i++] ?? ''));
  warnings.push(formatted.split('\n')[0].trim());
}

/** Test-only: what has been recorded and not yet reported. */
export function pendingActWarnings(): readonly string[] {
  return [...warnings];
}

/** Throw if anything was recorded since the last call, and reset. */
export function failOnActWarnings(): void {
  if (warnings.length === 0) return;
  const seen = [...new Set(warnings)];
  warnings.length = 0;
  throw new Error(
    `React logged ${seen.length === 1 ? 'an act() warning' : `${seen.length} act() warnings`} ` +
      'during this test. An update landed outside act(), so the assertions ran against a tree ' +
      `React had not finished updating.\n\n${seen.join('\n\n')}`,
  );
}
