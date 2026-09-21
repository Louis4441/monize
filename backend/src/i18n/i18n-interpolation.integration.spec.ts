import { Test, TestingModule } from "@nestjs/testing";
import { I18nService } from "nestjs-i18n";
import { I18nModule } from "./i18n.module";
import { emailTranslator } from "./email-translator";
import { SUPPORTED_LOCALE_CODES } from "./config";

/**
 * Regression guard for the email/exception placeholder bug: the catalogues use
 * the `{{ name }}` convention, and nestjs-i18n's stock `string-format` formatter
 * rendered those verbatim as `{ name }`. This boots the real I18nModule (with our
 * custom formatter wired in) and asserts a catalogue value is actually
 * interpolated rather than emitted with literal braces.
 */
describe("i18n interpolation (real catalogue)", () => {
  let i18n: I18nService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [I18nModule],
    }).compile();
    i18n = moduleRef.get<I18nService>(I18nService);
  });

  it("interpolates a {{ name }} placeholder from a catalogue string", () => {
    const t = emailTranslator(i18n, "en");
    const greeting = t(
      "emails.budgetAlertImmediate.greeting",
      "Hi {{ name }},",
      {
        name: "Ken",
      },
    );
    expect(greeting).toBe("Hi Ken,");
    expect(greeting).not.toContain("{");
  });

  it("interpolates a {{ count }} placeholder in an email subject", () => {
    const t = emailTranslator(i18n, "en");
    const subject = t(
      "emails.budgetAlertImmediate.subjectPlural",
      "Monize: {{ count }} alerts need attention",
      { count: 4 },
    );
    expect(subject).toBe("Monize: 4 alerts need attention");
  });

  /**
   * The parameter-rejection templates, against the real catalogues.
   *
   * These cannot be covered by a controller spec: `tr` returns its fallback
   * when no request context is present, and the fallback is the sentence with
   * the parameter already substituted. A spec that asserts the thrown message
   * therefore passes whether or not `{{ param }}` ever interpolates -- and a
   * template that did not would put a literal `{{ param }}` in front of every
   * reader whose locale is not English.
   */
  describe("the parameter templates", () => {
    it("names the parameter in English, with no braces left", () => {
      const message = i18n.translate("errors.params.mustBeCalendarDate", {
        lang: "en",
        args: { param: "startDate" },
      });

      expect(message).toBe(
        'The value of "startDate" must be a date in YYYY-MM-DD format',
      );
      expect(message).not.toContain("{");
    });

    it("names it in a locale whose sentence is not English", () => {
      // Polish is the locale the report came from: the message must open with
      // Polish and carry the identifier as quoted data, not open with the
      // identifier itself.
      const message = i18n.translate("errors.params.mustBeCalendarDate", {
        lang: "pl",
        args: { param: "startDate" },
      }) as string;

      expect(message).toContain('"startDate"');
      expect(message).not.toContain("{");
      expect(message.startsWith("startDate")).toBe(false);
      expect(message.startsWith("Wartość")).toBe(true);
    });

    it("interpolates both parameters of a two-parameter template", () => {
      const message = i18n.translate("errors.params.onOrBefore", {
        lang: "en",
        args: { param: "startDate", other: "endDate" },
      });

      expect(message).toBe(
        'The value of "startDate" must be on or before "endDate"',
      );
    });

    it("interpolates the option list a preset rejection names", () => {
      const message = i18n.translate("errors.params.mustBeOneOf", {
        lang: "en",
        args: { param: "granularity", options: "daily, monthly" },
      });

      expect(message).toBe(
        'The value of "granularity" must be one of: daily, monthly',
      );
    });

    it("opens with translated prose in every locale, never with the identifier", () => {
      // The defect this whole family was reworded for: 38 messages began with
      // a bare English token, so a translated string read as a broken one.
      for (const lang of SUPPORTED_LOCALE_CODES) {
        if (lang === "xx") continue; // the pseudo-locale brackets everything
        const message = i18n.translate("errors.params.mustBeArray", {
          lang,
          args: { param: "accountIds" },
        }) as string;
        // Asserted as a labelled object, because Jest's `expect` takes no
        // message argument: a failure then names the locale that broke.
        expect({
          lang,
          opensWithIdentifier: /^accountIds/.test(message),
          namesIdentifier: message.includes('"accountIds"'),
          leftBraces: message.includes("{"),
        }).toEqual({
          lang,
          opensWithIdentifier: false,
          namesIdentifier: true,
          leftBraces: false,
        });
      }
    });
  });
});
