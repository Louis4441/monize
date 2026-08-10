import {
  CONTINUATION_NUDGE,
  MAX_CONTINUATION_NUDGES,
  isDeferredContinuation,
} from "./continuation";

describe("isDeferredContinuation", () => {
  /**
   * The reply that motivated this: a real answer from the assistant that
   * ended mid-investigation, with no tool call, promising a second message
   * the loop could never send.
   */
  const REPORTED = [
    "I've identified the 17 split transactions in your [WS Chequing](monize://account/acct-1) account that contain the [Business: Cell Phone](monize://category/cat-1) category.",
    "",
    "To update only that specific line while leaving the other categories in each split untouched, I need to resend the full list of splits for each transaction. I am currently gathering the complete split details for those 17 transactions so I can propose the correct updates for you. One moment.",
  ].join("\n");

  it("catches the reported stall", () => {
    expect(isDeferredContinuation(REPORTED)).toBe(true);
  });

  describe("asking the user to wait", () => {
    const waits = [
      "Working through them now. One moment.",
      "Just a moment while I put the numbers together.",
      "I will have those totals for you momentarily.",
      "Give me a second and I'll have the breakdown.",
      "Hold on, there are a few more accounts to check.",
      "Hang tight while I total these up.",
      "Please wait while the remaining splits are collected.",
      "Bear with me, this one has a lot of lines.",
      "Full breakdown coming right up.",
      "I'll get back to you with the rest of the categories.",
    ];

    it.each(waits)("defers: %s", (text) => {
      expect(isDeferredContinuation(text)).toBe(true);
    });

    it("still defers when the tail also offers to do more", () => {
      // A wait request settles it: the user is left waiting either way, so an
      // offer bolted onto the same sentence does not make it an answer.
      expect(
        isDeferredContinuation(
          "Let me know if you want the rest as well. One moment while I pull them.",
        ),
      ).toBe(true);
    });
  });

  describe("announcing work instead of doing it", () => {
    const announcements = [
      "I am now retrieving the split details for each transaction.",
      "I'm gathering the remaining transactions.",
      "I'm still checking the other two accounts.",
      "I'll pull the full list of splits next.",
      "I will now compile the category totals.",
      "I'm going to look up the transactions in that range.",
      "Let me fetch the rest of the splits.",
      "Continuing with the remaining accounts now.",
      "Working on it now.",
    ];

    it.each(announcements)("defers: %s", (text) => {
      expect(isDeferredContinuation(text)).toBe(true);
    });
  });

  describe("finished answers", () => {
    const answers = [
      "You spent $3,240.18 across 45 transactions in January 2026.",
      "Your largest category was Groceries at $812.40, followed by Dining at $431.02.",
      "No transactions were found in that period.",
      // The offer that reads like a promise but is not: the model has
      // finished and put the next move in the user's hands.
      "That covers the chequing account. I'll pull the savings account too if you want.",
      "Let me know if you'd like this broken down by month.",
      "I've updated the totals above. Want me to chart them?",
      "Just say the word and I'll check the other accounts.",
      // Narration of work already done, mid-answer, with the answer after it.
      "I pulled the split details for all 17 transactions. Let me summarize what they show: the Business: Cell Phone line totals $1,204.55 across the year.",
    ];

    it.each(answers)("does not defer: %s", (text) => {
      expect(isDeferredContinuation(text)).toBe(false);
    });

    it("does not defer on a clarifying question", () => {
      // A question hands the decision to the user on purpose; looping would
      // answer it for them.
      expect(
        isDeferredContinuation(
          "There are two accounts named Chequing. Shall I check both, or just the joint one?",
        ),
      ).toBe(false);
    });

    it("does not defer on empty or whitespace-only text", () => {
      expect(isDeferredContinuation("")).toBe(false);
      expect(isDeferredContinuation("   \n  ")).toBe(false);
    });
  });

  it("looks only at the tail, not the whole message", () => {
    // The same stall phrasing early in a long message, followed by a real
    // answer, is narration -- the answer is right there.
    const narrated =
      "I am gathering the split details for those 17 transactions." +
      " ".repeat(300) +
      "The Business: Cell Phone line totals $1,204.55 for 2025.";
    expect(isDeferredContinuation(narrated)).toBe(false);
  });
});

describe("CONTINUATION_NUDGE", () => {
  it("offers both exits, so a false positive still produces an answer", () => {
    expect(CONTINUATION_NUDGE).toMatch(/call the tools/i);
    expect(CONTINUATION_NUDGE).toMatch(/final answer/i);
  });

  it("tells the model its turn does not resume", () => {
    expect(CONTINUATION_NUDGE).toMatch(/cannot continue/i);
  });
});

describe("MAX_CONTINUATION_NUDGES", () => {
  it("is bounded, so a model that will not comply cannot burn the budget", () => {
    expect(MAX_CONTINUATION_NUDGES).toBeGreaterThanOrEqual(1);
    expect(MAX_CONTINUATION_NUDGES).toBeLessThanOrEqual(3);
  });
});
