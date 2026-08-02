import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";
import { Account } from "../accounts/entities/account.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { DelegateOperation } from "./decorators/delegate-access.decorator";

/** How the real user reaches an account: they own it, or it is shared to them. */
export interface AccountAccess {
  account: Account;
  ownerUserId: string;
  via: "own" | "delegation";
}

/**
 * Cross-owner account authorization for transfers (cross-owner-transfers plan,
 * Phase 1). The single rule: for each account a transfer touches, the REAL
 * user (`req.user.realUserId`) must either own it or hold an active delegation
 * from its owner with the matching per-account grant. Own-context requests
 * bypass the delegate guard entirely, so this service -- not the guard -- is
 * the authoritative check; the guard stays as defense-in-depth for acting
 * tokens.
 *
 * Lives beside DelegationService rather than inside it because that file is at
 * the line-count cap.
 */
@Injectable()
export class CrossOwnerAccessService {
  constructor(private dataSource: DataSource) {}

  /**
   * Authorize `realUserId` to perform `op` on `accountId`, whoever owns it.
   * Decision order: account exists -> owned by the real user -> `via: "own"`;
   * else an active delegation from the account's owner with a READ grant row
   * -> op flag check -> `via: "delegation"` or 403; else 404. An account the
   * real user cannot read 404s exactly like a nonexistent one -- never
   * confirm existence.
   */
  async accountAccessFor(
    realUserId: string,
    accountId: string,
    op: DelegateOperation,
  ): Promise<AccountAccess> {
    const account = await this.loadAccountForAuthorization(accountId);
    if (!account) {
      throw this.accountNotFound(accountId);
    }
    if (account.userId === realUserId) {
      return { account, ownerUserId: realUserId, via: "own" };
    }

    const grant = await withScopedDb(this.dataSource, async (manager) => {
      const delegation = await manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId: account.userId,
          delegateUserId: realUserId,
          status: "active",
        },
      });
      if (!delegation) return null;
      return manager.getRepository(AccountDelegateGrant).findOne({
        where: { delegationId: delegation.id, accountId, canRead: true },
      });
    });
    if (!grant) {
      throw this.accountNotFound(accountId);
    }
    if (!this.grantAllows(grant, op)) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.accountOperationNotGranted",
          `The account owner has not granted you permission to ${op} transactions in this account.`,
          { operation: op },
        ),
      );
    }
    return { account, ownerUserId: account.userId, via: "delegation" };
  }

  /**
   * Every account id the real user may read: their own accounts plus every
   * `can_read`-granted account across all active delegations where they are
   * the delegate. One definition serves counterpart masking in both contexts
   * (acting-as-owner, and the delegate's own session).
   */
  async readableAccountIdSetFor(realUserId: string): Promise<Set<string>> {
    // Authorization-decision read: while acting as an owner the ambient
    // identity cannot see the real user's own account rows, so the own-account
    // id list is read under system context (ids only, nothing returned to the
    // client).
    const ownIds = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).find({
          where: { userId: realUserId },
          select: ["id"],
        }),
      ),
    );

    const grantedIds = await withScopedDb(this.dataSource, async (manager) => {
      const delegations = await manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        select: ["id"],
      });
      if (delegations.length === 0) return [] as AccountDelegateGrant[];
      return manager.getRepository(AccountDelegateGrant).find({
        where: {
          delegationId: In(delegations.map((d) => d.id)),
          canRead: true,
        },
        select: ["accountId"],
      });
    });

    return new Set<string>([
      ...ownIds.map((a) => a.id),
      ...grantedIds.map((g) => g.accountId),
    ]);
  }

  /** Whether `accountId` exists and is owned by `userId`. */
  async isAccountOwnedBy(accountId: string, userId: string): Promise<boolean> {
    // Authorization-decision read: the delegate guard calls this under an
    // acting (owner-scoped) identity to probe the real user's OWN account,
    // which that identity cannot see -- so the existence probe runs under
    // system context. Nothing beyond the boolean leaves this method.
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).exists({
          where: { id: accountId, userId },
        }),
      ),
    );
  }

  /**
   * Authorization-decision read: the account row is loaded by id with no user
   * filter -- learning a foreign account's owner is the decision input, and
   * the row is only returned to callers after `accountAccessFor` has
   * authorized the real user against it.
   */
  private loadAccountForAuthorization(
    accountId: string,
  ): Promise<Account | null> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).findOne({ where: { id: accountId } }),
      ),
    );
  }

  private grantAllows(
    grant: AccountDelegateGrant,
    op: DelegateOperation,
  ): boolean {
    switch (op) {
      case "read":
        return true;
      case "create":
        return grant.canCreate;
      case "edit":
        return grant.canEdit;
      case "delete":
        return grant.canDelete;
    }
  }

  /** The same 404 shape the owner-scoped account lookup produces today. */
  private accountNotFound(accountId: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.accounts.accountWithIdNotFound",
        `Account with ID ${accountId} not found`,
        { id: accountId },
      ),
    );
  }
}
