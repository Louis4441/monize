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
  "[SYSTEM] Your turn ended without a tool call, but your message says you are still working. " +
  "You cannot continue after your turn ends -- nothing runs in between, and the user sees only the promise. " +
  "Either call the tools you still need now, in this same turn, or give your complete final answer from the data you already have. " +
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
 * How much of the message tail is examined. Long enough to hold the closing
 * sentence or two where a deferral lives, short enough that a mid-answer
 * mention ("I pulled the details, let me summarize what they show: ...")
 * followed by the actual summary does not trip it.
 */
const TAIL_CHARS = 240;

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
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return false;

  const tail = trimmed.slice(-TAIL_CHARS);
  if (WAIT_PATTERNS.some((pattern) => pattern.test(tail))) return true;
  if (OFFER_PATTERNS.some((pattern) => pattern.test(tail))) return false;
  return WORK_PATTERNS.some((pattern) => pattern.test(tail));
}
