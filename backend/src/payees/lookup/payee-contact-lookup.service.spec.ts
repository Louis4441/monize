import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { validateUrlIsSafe } from "../../ai/validators/safe-url.validator";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import {
  ContactLookupUnavailableError,
  PAYEE_CONTACT_LOOKUP_PROVIDER,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);
jest.mock("../../ai/validators/safe-url.validator", () => ({
  validateUrlIsSafe: jest.fn().mockResolvedValue(true),
}));

const mockValidateUrlIsSafe = validateUrlIsSafe as jest.Mock;

describe("PayeeContactLookupService", () => {
  let service: PayeeContactLookupService;
  let provider: { lookup: jest.Mock };
  let preferenceRepo: Record<string, jest.Mock>;
  const userId = "user-1";

  const suggestion: PayeeContactSuggestion = {
    website: "https://acme.example",
    address: "1 Main St",
    email: "hi@acme.example",
    phone: "+1 555 010 2000",
    source: "ai-web-search",
    confidence: "high",
    notes: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockValidateUrlIsSafe.mockResolvedValue(true);
    provider = { lookup: jest.fn().mockResolvedValue(suggestion) };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId,
        payeeContactLookupEnabled: true,
        language: "en-CA",
        defaultCurrency: "CAD",
      }),
    };
    const scoped = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    const module = await Test.createTestingModule({
      providers: [
        PayeeContactLookupService,
        { provide: DataSource, useValue: scoped.dataSource },
        { provide: PAYEE_CONTACT_LOOKUP_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = module.get(PayeeContactLookupService);
  });

  it("returns disabled without calling the provider when the preference is off", async () => {
    preferenceRepo.findOne.mockResolvedValue({
      userId,
      payeeContactLookupEnabled: false,
    });

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "disabled",
      suggestion: null,
    });
    expect(provider.lookup).not.toHaveBeenCalled();
  });

  it("treats a missing preferences row as disabled", async () => {
    preferenceRepo.findOne.mockResolvedValue(null);

    await expect(service.isEnabled(userId)).resolves.toBe(false);
    await expect(
      service.lookup(userId, { name: "Acme" }),
    ).resolves.toMatchObject({
      reason: "disabled",
    });
  });

  it("ignores the preference only when the caller says the click was the consent", async () => {
    preferenceRepo.findOne.mockResolvedValue({
      userId,
      payeeContactLookupEnabled: false,
    });

    await expect(
      service.lookup(userId, { name: "Acme" }, { ignorePreference: true }),
    ).resolves.toEqual({ reason: "ok", suggestion });
  });

  it("passes the stored locale and currency as the hint when the caller gave none", async () => {
    await service.lookup(userId, { name: "Acme" });

    expect(provider.lookup).toHaveBeenCalledWith(userId, {
      name: "Acme",
      hint: "the user's locale is en-CA; their default currency is CAD",
    });
  });

  it("keeps a caller-supplied hint", async () => {
    await service.lookup(userId, { name: "Acme", hint: "Springfield" });

    expect(provider.lookup).toHaveBeenCalledWith(userId, {
      name: "Acme",
      hint: "Springfield",
    });
  });

  it("returns none when the provider found nothing", async () => {
    provider.lookup.mockResolvedValue(null);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "none",
      suggestion: null,
    });
  });

  it("drops only the website when it does not pass the URL safety check", async () => {
    mockValidateUrlIsSafe.mockResolvedValue(false);

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "ok",
      suggestion: { ...suggestion, website: null },
    });
    expect(mockValidateUrlIsSafe).toHaveBeenCalledWith("https://acme.example");
  });

  it("returns none when dropping the website leaves nothing", async () => {
    mockValidateUrlIsSafe.mockResolvedValue(false);
    provider.lookup.mockResolvedValue({
      ...suggestion,
      address: null,
      email: null,
      phone: null,
    });

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "none",
      suggestion: null,
    });
  });

  it("maps the adapter's no_provider to its own outcome without logging", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    provider.lookup.mockRejectedValue(
      new ContactLookupUnavailableError("no_provider"),
    );

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "no_provider",
      suggestion: null,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("carries the adapter's actionable failure detail", async () => {
    provider.lookup.mockRejectedValue(
      new ContactLookupUnavailableError(
        "failed",
        "Your MCP relay agent is not connected.",
      ),
    );

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "failed",
      suggestion: null,
      detail: "Your MCP relay agent is not connected.",
    });
  });

  it("never rejects: an unexpected error becomes failed, logged once", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    provider.lookup.mockRejectedValue(new TypeError("fetch failed"));

    await expect(service.lookup(userId, { name: "Acme" })).resolves.toEqual({
      reason: "failed",
      suggestion: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("fetch failed");
    warn.mockRestore();
  });
});
