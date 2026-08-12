import { isSessionSettled } from "./settled-bar.util";

const NYSE = {
  marketTimezone: "America/New_York",
  marketCloseTime: "16:00:00",
};

/** An instant, written as UTC so the fixture says what it means. */
const at = (iso: string) => new Date(iso);

describe("isSessionSettled", () => {
  describe("with a known market session", () => {
    it("is unsettled while the session is still running", () => {
      // 14:42 New York -- the hour the app's own auto-refresh was writing
      // quotes at, and the reason a mid-session price ended up stored as a
      // close.
      expect(
        isSessionSettled("2026-08-11", NYSE, at("2026-08-11T18:42:00Z")),
      ).toBe(false);
    });

    it("is unsettled one minute before the close", () => {
      expect(
        isSessionSettled("2026-08-11", NYSE, at("2026-08-11T19:59:00Z")),
      ).toBe(false);
    });

    it("is settled at the close instant", () => {
      expect(
        isSessionSettled("2026-08-11", NYSE, at("2026-08-11T20:00:00Z")),
      ).toBe(true);
    });

    it("is settled after the close", () => {
      expect(
        isSessionSettled("2026-08-11", NYSE, at("2026-08-11T21:00:00Z")),
      ).toBe(true);
    });

    it("is settled for any earlier day, whatever the time of day", () => {
      expect(
        isSessionSettled("2026-08-10", NYSE, at("2026-08-11T13:00:00Z")),
      ).toBe(true);
    });

    it("is unsettled for a day that has not arrived", () => {
      expect(
        isSessionSettled("2026-08-12", NYSE, at("2026-08-11T21:00:00Z")),
      ).toBe(false);
    });

    /**
     * The close is a *local* time, so the epoch instant it maps to moves by an
     * hour twice a year. 21:00 UTC is 17:00 in New York in August and 16:00 in
     * January -- past the close in one and exactly at it in the other, and both
     * settled. 20:30 UTC separates them: past the close in summer, half an hour
     * short of it in winter.
     */
    it("follows the market's clock across a daylight-saving change", () => {
      expect(
        isSessionSettled("2026-08-11", NYSE, at("2026-08-11T20:30:00Z")),
      ).toBe(true);
      expect(
        isSessionSettled("2026-01-13", NYSE, at("2026-01-13T20:30:00Z")),
      ).toBe(false);
      expect(
        isSessionSettled("2026-01-13", NYSE, at("2026-01-13T21:00:00Z")),
      ).toBe(true);
    });

    /**
     * The stored close is the provider's answer for that specific day, so a
     * half day settles early rather than at the usual hour.
     */
    it("honours an early close", () => {
      const halfDay = { ...NYSE, marketCloseTime: "13:00:00" };
      expect(
        isSessionSettled("2026-11-27", halfDay, at("2026-11-27T18:30:00Z")),
      ).toBe(true);
    });

    /**
     * Sydney's session opens and closes on a calendar day that is already
     * tomorrow in UTC for part of the year. Comparing in the market's own zone
     * is what keeps that a session rather than an off-by-one.
     */
    it("reads an antipodean session on its own calendar", () => {
      const asx = {
        marketTimezone: "Australia/Sydney",
        marketCloseTime: "16:00:00",
      };
      // 2026-08-12 06:00 UTC is 16:00 in Sydney on the 12th: settled.
      expect(
        isSessionSettled("2026-08-12", asx, at("2026-08-12T06:00:00Z")),
      ).toBe(true);
      // 2026-08-12 03:00 UTC is 13:00 in Sydney on the 12th: still trading.
      expect(
        isSessionSettled("2026-08-12", asx, at("2026-08-12T03:00:00Z")),
      ).toBe(false);
      // 2026-08-11 23:00 UTC is already the 12th in Sydney, an hour into the
      // session -- and the 11th is over.
      expect(
        isSessionSettled("2026-08-11", asx, at("2026-08-11T23:00:00Z")),
      ).toBe(true);
    });
  });

  describe("without a usable session", () => {
    /**
     * Nothing has quoted this security yet, so nothing knows when its market
     * closes. Falling back to "yesterday and earlier" costs a day's delay
     * before the official bar lands; guessing the other way would store a
     * part-session as a close, which is the defect this whole predicate
     * exists to stop.
     */
    it("settles only days strictly before today (UTC)", () => {
      const none = { marketTimezone: null, marketCloseTime: null };
      expect(
        isSessionSettled("2026-08-10", none, at("2026-08-11T21:00:00Z")),
      ).toBe(true);
      expect(
        isSessionSettled("2026-08-11", none, at("2026-08-11T21:00:00Z")),
      ).toBe(false);
    });

    it("falls back when only half the session is known", () => {
      const partial = {
        marketTimezone: "America/New_York",
        marketCloseTime: null,
      };
      expect(
        isSessionSettled("2026-08-11", partial, at("2026-08-11T21:00:00Z")),
      ).toBe(false);
      expect(
        isSessionSettled("2026-08-10", partial, at("2026-08-11T21:00:00Z")),
      ).toBe(true);
    });

    it("falls back rather than throwing on a zone the runtime cannot resolve", () => {
      const bogus = {
        marketTimezone: "Mars/Olympus_Mons",
        marketCloseTime: "16:00:00",
      };
      expect(
        isSessionSettled("2026-08-10", bogus, at("2026-08-11T21:00:00Z")),
      ).toBe(true);
      expect(
        isSessionSettled("2026-08-11", bogus, at("2026-08-11T21:00:00Z")),
      ).toBe(false);
    });
  });
});
