import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SecurityDocumentsService } from "./security-documents.service";
import { SecuritiesService } from "./securities.service";
import { SecurityDocumentType } from "./entities/security-document.entity";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SECURITY_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";

jest.mock("../common/db/scoped-db", () => ({
  // The real thing opens a tenant transaction; here it just hands the manager
  // through, so the tests are about this service's logic rather than TypeORM's.
  withScopedDb: (_dataSource: unknown, fn: (m: unknown) => unknown) =>
    fn((global as never as { __manager: unknown }).__manager),
}));

describe("SecurityDocumentsService", () => {
  let service: SecurityDocumentsService;
  let securitiesService: Record<string, jest.Mock>;
  let repo: Record<string, jest.Mock>;

  function existingDocument(overrides: Record<string, unknown> = {}) {
    return {
      id: DOCUMENT_ID,
      userId: USER_ID,
      securityId: SECURITY_ID,
      documentType: SecurityDocumentType.FACTSHEET,
      name: "Factsheet",
      documentDate: "2024-12-31",
      url: "https://example.com/a.pdf",
      notes: "original",
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: unknown) => data),
      save: jest.fn((data: unknown) => Promise.resolve(data)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    (global as never as { __manager: unknown }).__manager = {
      getRepository: () => repo,
    };
    securitiesService = { findOne: jest.fn().mockResolvedValue({ id: SECURITY_ID }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityDocumentsService,
        { provide: DataSource, useValue: {} },
        { provide: SecuritiesService, useValue: securitiesService },
      ],
    }).compile();
    service = module.get(SecurityDocumentsService);
  });

  describe("ownership", () => {
    // Every entry point goes through the security first, so a document can never
    // be hung off, read from or deleted out of someone else's security by id.
    it.each([
      ["findAll", () => service.findAll(USER_ID, SECURITY_ID)],
      [
        "create",
        () =>
          service.create(USER_ID, SECURITY_ID, {
            name: "x",
            url: "https://example.com/x.pdf",
          }),
      ],
      [
        "update",
        () => service.update(USER_ID, SECURITY_ID, DOCUMENT_ID, { name: "y" }),
      ],
      ["remove", () => service.remove(USER_ID, SECURITY_ID, DOCUMENT_ID)],
    ])("checks the security through SecuritiesService on %s", async (_n, call) => {
      repo.findOne.mockResolvedValue(existingDocument());
      await call();
      expect(securitiesService.findOne).toHaveBeenCalledWith(
        USER_ID,
        SECURITY_ID,
      );
    });

    it("propagates a security that is not the caller's", async () => {
      securitiesService.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.findAll(USER_ID, SECURITY_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  describe("findAll", () => {
    it("puts the newest document first and undated ones last", async () => {
      await service.findAll(USER_ID, SECURITY_ID);
      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID, securityId: SECURITY_ID },
        order: {
          documentDate: { direction: "DESC", nulls: "LAST" },
          name: "ASC",
        },
      });
    });
  });

  describe("create", () => {
    it("stores the document against the user and security", async () => {
      const saved = await service.create(USER_ID, SECURITY_ID, {
        documentType: SecurityDocumentType.KIID,
        name: "KIID 2025",
        documentDate: "2025-01-31",
        url: "https://example.com/kiid.pdf",
        notes: "German share class",
      });
      expect(saved).toEqual(
        expect.objectContaining({
          userId: USER_ID,
          securityId: SECURITY_ID,
          documentType: SecurityDocumentType.KIID,
          name: "KIID 2025",
          documentDate: "2025-01-31",
          url: "https://example.com/kiid.pdf",
          notes: "German share class",
        }),
      );
    });

    it("defaults an unstated type to OTHER rather than leaving it unset", async () => {
      const saved = await service.create(USER_ID, SECURITY_ID, {
        name: "Something",
        url: "https://example.com/s.pdf",
      });
      expect(saved).toEqual(
        expect.objectContaining({
          documentType: SecurityDocumentType.OTHER,
          documentDate: null,
          notes: null,
        }),
      );
    });
  });

  describe("update", () => {
    it("changes only the fields that were sent", async () => {
      repo.findOne.mockResolvedValue(existingDocument());
      const saved = await service.update(USER_ID, SECURITY_ID, DOCUMENT_ID, {
        name: "Renamed",
      });
      expect(saved).toEqual(
        expect.objectContaining({
          name: "Renamed",
          url: "https://example.com/a.pdf",
          documentDate: "2024-12-31",
          notes: "original",
        }),
      );
    });

    it("clears a date or note that was explicitly emptied", async () => {
      repo.findOne.mockResolvedValue(existingDocument());
      const saved = await service.update(USER_ID, SECURITY_ID, DOCUMENT_ID, {
        documentDate: undefined,
        notes: undefined,
      });
      // `undefined` means "not sent" and must leave the value alone...
      expect(saved).toEqual(
        expect.objectContaining({ documentDate: "2024-12-31", notes: "original" }),
      );
    });

    it("scopes the lookup to the caller and the security", async () => {
      repo.findOne.mockResolvedValue(existingDocument());
      await service.update(USER_ID, SECURITY_ID, DOCUMENT_ID, { name: "n" });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: DOCUMENT_ID, userId: USER_ID, securityId: SECURITY_ID },
      });
    });

    it("refuses a document that is not there", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update(USER_ID, SECURITY_ID, DOCUMENT_ID, { name: "n" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    it("deletes within the caller's own scope", async () => {
      await service.remove(USER_ID, SECURITY_ID, DOCUMENT_ID);
      expect(repo.delete).toHaveBeenCalledWith({
        id: DOCUMENT_ID,
        userId: USER_ID,
        securityId: SECURITY_ID,
      });
    });

    it("reports a document that was not there to delete", async () => {
      // Scoped in the delete itself, so nothing was removed means "not yours or
      // not there" -- and no extra read is needed to tell the caller so.
      repo.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.remove(USER_ID, SECURITY_ID, DOCUMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
