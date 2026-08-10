/**
 * A turn that ends by promising to keep working.
 *
 * Nothing runs between turns. When the model ends a turn with text like "I am
 * gathering the split details for those 17 transactions. One moment." and no
 * tool call attached, the agentic loop is over: control returns to the user,
 * the promised work never happens, and the assistant appears to have hung.
 * The user is left waiting for a second message that cannot arrive.
 *
 * Smaller and mid-tier models do this often -- they have been trained on
 * assistant transcripts where a human replies next -- so the loop cannot
 * assume a tool-free turn is an answer. It detects the promise, tells the model
 * that turns do not resume, and runs another pass. Two nudges in, the loop
 * gives up on the model volunteering and withdraws the tools, which forces an
 * answer from whatever was gathered.
 */

/**
 * How many times one query may be told to stop stalling and get on with it.
 * Two is deliberate: one nudge fixes the common single slip, a second covers a
 * model that stalls again on a different phrasing, and a third would just be
 * burning the user's tokens on a model that is not going to comply -- the
 * tool-free synthesis pass is the better answer at that point.
 */
export const MAX_CONTINUATION_NUDGES = 2;

/**
 * Sent as a user turn after a deferral, in place of the user the model was
 * expecting to hear from.
 *
 * It offers both exits deliberately. If the model really did have more to
 * gather, it calls the tool; if the deferral was a flourish on top of a
 * complete answer (which is what a false positive here looks like), restating
 * the answer costs one pass and the user still gets a proper reply.
 */
export const CONTINUATION_NUDGE =
  "[SYSTEM] Your turn ended without a tool call, but your message promises work you have not done. " +
  "You cannot continue after your turn ends -- nothing runs in between, and the user sees only the promise. " +
  "A confirmation card exists only if a write tool call in the SAME turn as your message created it; no card 'appears shortly'. " +
  "Either make the tool calls you still need now, in this same turn, or give your complete final answer from the data you already have. " +
  "Do not say you will continue, do not ask the user to wait, and do not acknowledge this message.";

/**
 * Asking the user to wait. Decisive on its own: there is no reading of "one
 * moment" at the end of a turn that does not leave the user waiting on a
 * message the loop will never send.
 */
const WAIT_PATTERNS: readonly RegExp[] = [
  /\b(?:one|just a|a) moment\b/i,
  /\bmomentarily\b/i,
  /\bgive me (?:a|one) (?:moment|second|sec|minute)\b/i,
  /\b(?:please )?(?:hold on|hang tight|stand by|standby|bear with me)\b/i,
  /\bplease wait\b/i,
  /\bwait (?:while|until) I\b/i,
  /\bcoming (?:right )?up\b/i,
  /\bget back to you\b/i,
  // Something is promised to happen on its own, after the turn. It cannot:
  // nothing runs between turns, so "shortly" never arrives.
  /\bshortly\b/i,
  /\bwill (?:appear|follow|be (?:ready|shown|displayed))\b/i,
  /\bin (?:just )?a (?:few )?(?:moment|moments|seconds|minutes)\b/i,
  /\bnext (?:message|reply|response)\b/i,
];

/**
 * Work announced but not performed -- present tense ("I am gathering") or
 * future ("I will now pull"). Weaker evidence than a wait request, because the
 * same verbs appear in an offer of further work, so these only count when the
 * tail is not an offer.
 */
const WORK_PATTERNS: readonly RegExp[] = [
  /\bI(?:'m| am) (?:currently |now |still )?(?:gathering|fetching|retrieving|pulling|collecting|compiling|assembling|preparing|checking|looking up|working on)\b/i,
  /\bI(?:'ll| will) (?:now |then |next )?(?:gather|fetch|retrieve|pull|collect|compile|assemble|prepare|check|look up|start|begin|continue|proceed|go ahead)\b/i,
  /\bI(?:'m| am) going to (?:gather|fetch|retrieve|pull|collect|compile|assemble|prepare|check|look up|start|begin|continue|proceed)\b/i,
  // "Let me ..." -- but never "let me know", which hands control back on
  // purpose and is how a great many perfectly good answers end.
  /\blet me (?!know\b)(?:gather|fetch|retrieve|pull|collect|compile|assemble|prepare|check|look|run|grab|get|continue|proceed|start|begin)\b/i,
  /\b(?:continuing|proceeding) (?:now|with|to)\b/i,
  /\bworking on (?:it|that|this) now\b/i,
];

/**
 * An answer that ends by offering to do more, conditional on the user saying
 * so. "I'll pull the rest if you want" is a finished answer with an offer
 * attached, not a stall -- looping on it would answer a question the model
 * deliberately left to the user.
 */
const OFFER_PATTERNS: readonly RegExp[] = [
  /\blet me know\b/i,
  /\bif you(?:'d| would)? (?:like|want|prefer)\b/i,
  /\bif you want\b/i,
  /\bwould you like\b/i,
  /\bwant me to\b/i,
  /\bshall I\b/i,
  /\bjust (?:say|ask|tell me)\b/i,
];

/**
 * A promise that the user is about to be shown a confirmation card.
 *
 * Unlike everything above, this one can be *checked*: a card exists only if a
 * write tool call in the same turn produced a pending action. A turn that
 * promises cards and emitted none has told the user something false, and the
 * loop knows which it is without weighing any prose. See
 * {@link promisesPendingAction}.
 */
const CARD_PROMISE_PATTERNS: readonly RegExp[] = [
  /\bconfirmation card/i,
  /\bapprove the (?:card|change|update|proposal)/i,
  /\breview and approve\b/i,
  /\bcards? (?:will|to) (?:appear|show|follow)\b/i,
];

/**
 * How much of the message tail is examined. Long enough to hold the closing
 * sentence or two where a deferral lives, short enough that a mid-answer
 * mention ("I pulled the details, let me summarize what they show: ...")
 * followed by the actual summary does not trip it.
 *
 * Measured after markdown link targets are stripped: a single
 * `[Automobile: Accessories](monize://category/...)` is ~60 characters of URL
 * the reader never sees, and two of them pushed the actual stall
 * ("I am currently gathering the remaining split details") out of the window
 * on the reply that motivated this.
 */
const TAIL_CHARS = 320;

/** Replace `[label](target)` with `label`, so a URL cannot fill the window. */
const stripLinkTargets = (value: string): string =>
  value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/**
 * Does this tool-free turn promise work instead of delivering it?
 *
 * Only meaningful for a turn that ended with no tool calls -- a turn that made
 * one is continuing by itself and needs no nudge.
 *
 * A tail ending in a question mark is never a deferral: "Shall I pull the rest?"
 * hands the decision to the user deliberately, and answering it for them by
 * looping is worse than the stall this guards against.
 */
export function isDeferredContinuation(text: string): boolean {
  const tail = messageTail(text);
  if (tail === null) return false;

  if (WAIT_PATTERNS.some((pattern) => pattern.test(tail))) return true;
  if (OFFER_PATTERNS.some((pattern) => pattern.test(tail))) return false;
  return WORK_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Does this turn tell the user a confirmation card is coming?
 *
 * The caller pairs it with what the turn actually emitted: promising a card
 * while proposing no action is a broken promise the loop can prove, rather
 * than a phrasing it has to judge. It is the reason the reported reply --
 * "Please review and approve the confirmation cards that will appear shortly",
 * with no write tool call anywhere in the turn -- is caught for what it is.
 *
 * Scoped to the whole message, not the tail: the promise may sit mid-message
 * with a summary after it, and it is false either way.
 */
export function promisesPendingAction(text: string): boolean {
  const trimmed = stripLinkTargets((text ?? "").trim());
  if (trimmed.length === 0) return false;
  // A question is asking permission to propose, not claiming to have done so.
  if (trimmed.endsWith("?")) return false;
  return CARD_PROMISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * The closing stretch of a message, or null when there is nothing to judge.
 * Link targets are stripped first so the window holds words rather than URLs.
 */
function messageTail(text: string): string | null {
  const trimmed = stripLinkTargets((text ?? "").trim()).trim();
  if (trimmed.length === 0) return null;
  // A trailing question hands the next move to the user deliberately.
  if (trimmed.endsWith("?")) return null;
  return trimmed.slice(-TAIL_CHARS);
}
