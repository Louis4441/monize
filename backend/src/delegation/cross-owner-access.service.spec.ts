import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrossOwnerAccessService } from "./cross-owner-access.service";
import { Account } from "../accounts/entities/account.entity";
import { User } from "../users/entities/user.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("CrossOwnerAccessService", () => {
  let service: CrossOwnerAccessService;
  let accountsRepo: Record<string, jest.Mock>;
  let delegatesRepo: Record<string, jest.Mock>;
  let grantsRepo: Record<string, jest.Mock>;

  const REAL_USER = "11111111-1111-4111-8111-111111111111";
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const DELEGATION_ID = "44444444-4444-4444-8444-444444444444";

  const ownAccount = { id: ACCOUNT_ID, userId: REAL_USER } as Account;
  const foreignAccount = { id: ACCOUNT_ID, userId: OWNER } as Account;
  const activeDelegation = { id: DELEGATION_ID } as AccountDelegate;

  function grant(flags: Partial<AccountDelegateGrant> = {}) {
    return {
      id: "g1",
      delegationId: DELEGATION_ID,
      accountId: ACCOUNT_ID,
      canRead: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
      ...flags,
    } as AccountDelegateGrant;
  }

  let usersRepo: Record<string, jest.Mock>;

  beforeEach(() => {
    accountsRepo = { findOne: jest.fn(), find: jest.fn(), exists: jest.fn() };
    delegatesRepo = { findOne: jest.fn(), find: jest.fn() };
    grantsRepo = { findOne: jest.fn(), find: jest.fn() };
    usersRepo = { findOne: jest.fn() };
    const scoped = createScopedDbMocks([
      [Account, accountsRepo as never],
      [AccountDelegate, delegatesRepo as never],
      [AccountDelegateGrant, grantsRepo as never],
      [User, usersRepo as never],
    ]);
    service = new CrossOwnerAccessService(scoped.dataSource as never);
  });

  describe("accountAccessFor", () => {
    it("resolves an account owned by the real user as via 'own' without touching delegations", async () => {
      accountsRepo.findOne.mockResolvedValue(ownAccount);

      const access = await service.accountAccessFor(
        REAL_USER,
        ACCOUNT_ID,
        "delete",
      );

      expect(access).toEqual({
        account: ownAccount,
        ownerUserId: REAL_USER,
        via: "own",
      });
      expect(delegatesRepo.findOne).not.toHaveBeenCalled();
      expect(grantsRepo.findOne).not.toHaveBeenCalled();
    });

    it("404s a nonexistent account without touching delegations", async () => {
      accountsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.accountAccessFor(REAL_USER, ACCOUNT_ID, "read"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(delegatesRepo.findOne).not.toHaveBeenCalled();
    });

    it("resolves a granted account as via 'delegation' when the op flag is set", async () => {
      accountsRepo.findOne.mockResolvedValue(foreignAccount);
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(grant({ canCreate: true }));

      const access = await service.accountAccessFor(
        REAL_USER,
        ACCOUNT_ID,
        "create",
      );

      expect(access).toEqual({
        account: foreignAccount,
        ownerUserId: OWNER,
        via: "delegation",
      });
      expect(delegatesRepo.findOne).toHaveBeenCalledWith({
        where: {
          ownerUserId: OWNER,
          delegateUserId: REAL_USER,
          status: "active",
        },
      });
      expect(grantsRepo.findOne).toHaveBeenCalledWith({
        where: {
          delegationId: DELEGATION_ID,
          accountId: ACCOUNT_ID,
          canRead: true,
        },
      });
    });

    it("allows read with a bare READ grant", async () => {
      accountsRepo.findOne.mockResolvedValue(foreignAccount);
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(grant());

      const access = await service.accountAccessFor(
        REAL_USER,
        ACCOUNT_ID,
        "read",
      );

      expect(access.via).toBe("delegation");
    });

    it.each<["create" | "edit" | "delete"]>([["create"], ["edit"], ["delete"]])(
      "403s a read-only grant for %s",
      async (op) => {
        accountsRepo.findOne.mockResolvedValue(foreignAccount);
        delegatesRepo.findOne.mockResolvedValue(activeDelegation);
        grantsRepo.findOne.mockResolvedValue(grant());

        await expect(
          service.accountAccessFor(REAL_USER, ACCOUNT_ID, op),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each<["edit" | "delete", Partial<AccountDelegateGrant>]>([
      ["edit", { canEdit: true }],
      ["delete", { canDelete: true }],
    ])("honors the %s flag on the grant row", async (op, flags) => {
      accountsRepo.findOne.mockResolvedValue(foreignAccount);
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(grant(flags));

      const access = await service.accountAccessFor(REAL_USER, ACCOUNT_ID, op);

      expect(access.via).toBe("delegation");
    });

    it("404s (never 403s) when the delegation grants no READ on the account", async () => {
      accountsRepo.findOne.mockResolvedValue(foreignAccount);
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.accountAccessFor(REAL_USER, ACCOUNT_ID, "read"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s when no active delegation exists (revoked or pending ones do not match)", async () => {
      accountsRepo.findOne.mockResolvedValue(foreignAccount);
      // The lookup filters on status: "active", so a revoked or pending
      // delegation row is indistinguishable from none at all.
      delegatesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.accountAccessFor(REAL_USER, ACCOUNT_ID, "edit"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(delegatesRepo.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: "active" }),
      });
      expect(grantsRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("readableAccountIdSetFor", () => {
    it("unions own account ids with can_read grants across active delegations", async () => {
      accountsRepo.find.mockResolvedValue([{ id: "own-1" }, { id: "own-2" }]);
      delegatesRepo.find.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      grantsRepo.find.mockResolvedValue([
        { accountId: "shared-1" },
        { accountId: "shared-2" },
      ]);

      const set = await service.readableAccountIdSetFor(REAL_USER);

      expect(set).toEqual(new Set(["own-1", "own-2", "shared-1", "shared-2"]));
      expect(accountsRepo.find).toHaveBeenCalledWith({
        where: { userId: REAL_USER },
        select: ["id"],
      });
      expect(delegatesRepo.find).toHaveBeenCalledWith({
        where: { delegateUserId: REAL_USER, status: "active" },
        select: ["id"],
      });
      const grantWhere = grantsRepo.find.mock.calls[0][0].where;
      expect(grantWhere.canRead).toBe(true);
      expect(grantWhere.delegationId.value).toEqual(["d1", "d2"]);
    });

    it("skips the grant query entirely when the user is a delegate of nobody", async () => {
      accountsRepo.find.mockResolvedValue([{ id: "own-1" }]);
      delegatesRepo.find.mockResolvedValue([]);

      const set = await service.readableAccountIdSetFor(REAL_USER);

      expect(set).toEqual(new Set(["own-1"]));
      expect(grantsRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("transferCandidatesFor", () => {
    const sharedAccount = {
      id: "acc-shared",
      name: "Owner Chequing",
      currencyCode: "CAD",
      accountType: "CHEQUING",
      accountSubType: null,
      isClosed: false,
      userId: OWNER,
      currentBalance: 999.99,
    };

    it("own context: returns granted accounts with per-op flags and owner label, nothing more", async () => {
      delegatesRepo.find.mockResolvedValue([
        {
          id: DELEGATION_ID,
          ownerUserId: OWNER,
          owner: { firstName: "Alice", lastName: "Owner", email: "a@x.com" },
        },
      ]);
      grantsRepo.find.mockResolvedValue([
        grant({ canCreate: true, canEdit: true, canDelete: false }),
      ]);
      accountsRepo.find.mockResolvedValue([
        { ...sharedAccount, id: ACCOUNT_ID },
      ]);

      const candidates = await service.transferCandidatesFor(
        REAL_USER,
        REAL_USER,
      );

      expect(candidates).toEqual([
        {
          id: ACCOUNT_ID,
          name: "Owner Chequing",
          currencyCode: "CAD",
          accountType: "CHEQUING",
          accountSubType: null,
          isClosed: false,
          ownerLabel: "Alice Owner",
          canCreate: true,
          canEdit: true,
          canDelete: false,
        },
      ]);
      // No balance or institution data leaves the endpoint.
      expect(Object.keys(candidates[0])).not.toContain("currentBalance");
    });

    it("own context: empty when the user is a delegate of nobody", async () => {
      delegatesRepo.find.mockResolvedValue([]);
      await expect(
        service.transferCandidatesFor(REAL_USER, REAL_USER),
      ).resolves.toEqual([]);
      expect(grantsRepo.find).not.toHaveBeenCalled();
    });

    it("acting context: returns the real user's own accounts with every flag true", async () => {
      accountsRepo.find.mockResolvedValue([
        {
          ...sharedAccount,
          id: "acc-own",
          name: "My Savings",
          userId: REAL_USER,
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: REAL_USER,
        firstName: "Bob",
        lastName: null,
        email: "b@x.com",
      });

      const candidates = await service.transferCandidatesFor(REAL_USER, OWNER);

      expect(candidates).toEqual([
        expect.objectContaining({
          id: "acc-own",
          name: "My Savings",
          ownerLabel: "Bob",
          canCreate: true,
          canEdit: true,
          canDelete: true,
        }),
      ]);
      expect(delegatesRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("isAccountOwnedBy", () => {
    it("probes existence scoped to both id and owner", async () => {
      accountsRepo.exists.mockResolvedValue(true);

      await expect(
        service.isAccountOwnedBy(ACCOUNT_ID, REAL_USER),
      ).resolves.toBe(true);
      expect(accountsRepo.exists).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID, userId: REAL_USER },
      });
    });

    it("returns false for an account the user does not own", async () => {
      accountsRepo.exists.mockResolvedValue(false);

      await expect(
        service.isAccountOwnedBy(ACCOUNT_ID, REAL_USER),
      ).resolves.toBe(false);
    });
  });
});
