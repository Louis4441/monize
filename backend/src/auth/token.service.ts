import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  DataSource,
  EntityTarget,
  LessThan,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { hashToken } from "./crypto.util";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";

export interface DelegationTokenContext {
  actingAsUserId: string;
  delegationId: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly ACCESS_TOKEN_EXPIRY = "15m";
  private readonly REFRESH_TOKEN_EXPIRY_MS = 1 * 24 * 60 * 60 * 1000; // 1 day
  private readonly REMEMBER_ME_EXPIRY_MS: number;

  constructor(
    private jwtService: JwtService,
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {
    const rememberMeDays = parseInt(
      this.configService.get<string>("REMEMBER_ME_DAYS", "30"),
      10,
    );
    this.REMEMBER_ME_EXPIRY_MS =
      (rememberMeDays > 0 ? rememberMeDays : 30) * 24 * 60 * 60 * 1000;
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  getRefreshExpiryMs(rememberMe?: boolean): number {
    return rememberMe
      ? this.REMEMBER_ME_EXPIRY_MS
      : this.REFRESH_TOKEN_EXPIRY_MS;
  }

  async generateTokenPair(
    user: User,
    rememberMe?: boolean,
    context?: DelegationTokenContext,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // SECURITY: `sub` is ALWAYS the real authenticated user. When acting as a
    // delegate the data-scoping id is carried separately in actingAsUserId so
    // refresh rotation / family revocation / replay detection keep keying off
    // the real user.
    const payload: Record<string, unknown> = {
      sub: user.id,
      email: user.email,
      authProvider: user.authProvider,
      role: user.role,
    };
    if (context?.actingAsUserId && context?.delegationId) {
      payload.actingAsUserId = context.actingAsUserId;
      payload.delegationId = context.delegationId;
    }
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
    });

    const rawRefreshToken = crypto.randomBytes(64).toString("hex");
    const tokenHash = hashToken(rawRefreshToken);
    const familyId = crypto.randomUUID();
    const expiryMs = this.getRefreshExpiryMs(rememberMe);

    await withScopedDb(this.dataSource, (manager) => {
      const repo = manager.getRepository(RefreshToken);
      return repo.save(
        repo.create({
          userId: user.id,
          tokenHash,
          familyId,
          isRevoked: false,
          expiresAt: new Date(Date.now() + expiryMs),
          replacedByHash: null,
          rememberMe: !!rememberMe,
          actingAsUserId: context?.actingAsUserId ?? null,
          delegationId: context?.delegationId ?? null,
        }),
      );
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  async refreshTokens(
    rawRefreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const tokenHash = hashToken(rawRefreshToken);

    return withScopedDb(this.dataSource, async (manager) => {
      // SECURITY: Pessimistic lock prevents race condition when two requests
      // try to rotate the same refresh token concurrently
      const existingToken = await manager.findOne(RefreshToken, {
        where: { tokenHash },
        lock: { mode: "pessimistic_write" },
      });

      if (!existingToken) {
        throw new UnauthorizedException(
          tr("errors.auth.invalidRefreshToken", "Invalid refresh token"),
        );
      }

      // Replay detection: if token is revoked, a previously-rotated token was reused
      if (existingToken.isRevoked) {
        await manager.update(
          RefreshToken,
          { familyId: existingToken.familyId },
          { isRevoked: true },
        );
        throw new UnauthorizedException(
          tr(
            "errors.auth.refreshTokenReuseDetected",
            "Refresh token reuse detected",
          ),
        );
      }

      if (existingToken.expiresAt < new Date()) {
        existingToken.isRevoked = true;
        await manager.save(existingToken);
        throw new UnauthorizedException(
          tr("errors.auth.refreshTokenExpired", "Refresh token expired"),
        );
      }

      const user = await manager.findOne(User, {
        where: { id: existingToken.userId },
      });

      if (!user || !user.isActive) {
        await manager.update(
          RefreshToken,
          { familyId: existingToken.familyId },
          { isRevoked: true },
        );
        throw new UnauthorizedException(
          tr(
            "errors.auth.userNotFoundOrInactive",
            "User not found or inactive",
          ),
        );
      }

      // Rotate: generate new refresh token in the same family
      const newRawRefreshToken = crypto.randomBytes(64).toString("hex");
      const newTokenHash = hashToken(newRawRefreshToken);

      existingToken.isRevoked = true;
      existingToken.replacedByHash = newTokenHash;
      await manager.save(existingToken);

      const rotatedExpiryMs = this.getRefreshExpiryMs(existingToken.rememberMe);
      const newRefreshTokenEntity = manager.create(RefreshToken, {
        userId: user.id,
        tokenHash: newTokenHash,
        familyId: existingToken.familyId,
        isRevoked: false,
        expiresAt: new Date(Date.now() + rotatedExpiryMs),
        replacedByHash: null,
        rememberMe: existingToken.rememberMe,
        // Carry the delegate "acting as owner" context forward through
        // rotation so the context survives access-token expiry.
        actingAsUserId: existingToken.actingAsUserId ?? null,
        delegationId: existingToken.delegationId ?? null,
      });
      await manager.save(newRefreshTokenEntity);

      const payload: Record<string, unknown> = {
        sub: user.id,
        email: user.email,
        authProvider: user.authProvider,
        role: user.role,
      };
      if (existingToken.actingAsUserId && existingToken.delegationId) {
        payload.actingAsUserId = existingToken.actingAsUserId;
        payload.delegationId = existingToken.delegationId;
      }
      const accessToken = this.jwtService.sign(payload, {
        expiresIn: this.ACCESS_TOKEN_EXPIRY,
      });

      return {
        accessToken,
        refreshToken: newRawRefreshToken,
        userId: user.id,
      };
    });
  }

  async revokeTokenFamily(familyId: string): Promise<void> {
    await this.scoped(RefreshToken, (repo) =>
      repo.update({ familyId }, { isRevoked: true }),
    );
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = hashToken(rawRefreshToken);
    const token = await this.scoped(RefreshToken, (repo) =>
      repo.findOne({
        where: { tokenHash },
      }),
    );
    if (token) {
      await this.revokeTokenFamily(token.familyId);
    }
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.scoped(RefreshToken, (repo) =>
      repo.update({ userId, isRevoked: false }, { isRevoked: true }),
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRefreshTokens(): Promise<void> {
    // RLS (task C2): cross-user bulk purge -- runs under a system context.
    return withSystemContext(() =>
      this.purgeExpiredRefreshTokensWithinContext(),
    );
  }

  private async purgeExpiredRefreshTokensWithinContext(): Promise<void> {
    const expiredResult = await this.scoped(RefreshToken, (repo) =>
      repo.delete({
        expiresAt: LessThan(new Date()),
      }),
    );

    const revokedResult = await this.scoped(RefreshToken, (repo) =>
      repo.delete({
        isRevoked: true,
      }),
    );

    const totalPurged =
      (expiredResult.affected || 0) + (revokedResult.affected || 0);
    if (totalPurged > 0) {
      this.logger.log(`Purged ${totalPurged} expired/revoked refresh tokens`);
    }
  }
}
