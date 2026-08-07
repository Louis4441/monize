import type { Adapter, AdapterPayload } from "oidc-provider";
import { DataSource } from "typeorm";
import { OAuthPayload } from "./entities/oauth-payload.entity";

const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

/**
 * `oidc-provider`'s storage adapter, and the one place in the application that
 * reaches a table through a bare `DataSource` rather than `withScopedDb`.
 *
 * This is deliberate, and narrowly bounded. `node-oidc-provider` is mounted as
 * raw Express middleware in `main.ts`, outside Nest's request pipeline, so
 * these calls have **no ambient identity context at all** -- not a request
 * scope, and not `withSystemContext` either. Their safety does not come from
 * identity GUCs. It comes from `oauth_payloads` being RLS-exempt with no owner
 * column, addressed only by opaque provider identifiers, and from the runtime
 * role's grants on it being confined to the DML below.
 *
 * This is not precedent for any user-owned table: everything else goes through
 * `withScopedDb` (`src/common/db/scoped-db.ts`). The full boundary -- rejected
 * alternatives, consequences, and the triggers that would invalidate the
 * exception -- is `docs/row-level-security-contract.md`, and
 * `src/oauth/oauth-payload-access.spec.ts` plus the `OAUTH_PAYLOAD_ALLOWLIST`
 * ban in `eslint.config.mjs` fail when a new production reader appears.
 */
export class PostgresAdapter implements Adapter {
  constructor(
    private readonly model: string,
    private readonly dataSource: DataSource,
  ) {}

  private get repo() {
    return this.dataSource.getRepository(OAuthPayload);
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<void> {
    const expiresAt =
      expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    await this.repo.upsert(
      {
        id,
        model: this.model,
        payload: payload as unknown as Record<string, unknown>,
        grantId: GRANTABLE_MODELS.has(this.model)
          ? (payload.grantId ?? null)
          : null,
        userCode:
          this.model === "DeviceCode" ? (payload.userCode ?? null) : null,
        uid: this.model === "Session" ? (payload.uid ?? null) : null,
        expiresAt,
        consumedAt: null,
      } as OAuthPayload,
      { conflictPaths: ["id", "model"] },
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({ where: { id, model: this.model } });
    return this.toPayload(row);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({
      where: { userCode, model: this.model },
    });
    return this.toPayload(row);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.repo.findOne({ where: { uid, model: this.model } });
    return this.toPayload(row);
  }

  async consume(id: string): Promise<void> {
    await this.repo.update(
      { id, model: this.model },
      { consumedAt: new Date() },
    );
  }

  async destroy(id: string): Promise<void> {
    await this.repo.delete({ id, model: this.model });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.repo.delete({ grantId });
  }

  private toPayload(row: OAuthPayload | null): AdapterPayload | undefined {
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    const result = { ...row.payload } as AdapterPayload;
    if (row.consumedAt) {
      (result as { consumed?: number }).consumed = Math.floor(
        row.consumedAt.getTime() / 1000,
      );
    }
    return result;
  }
}

export function makeAdapterFactory(dataSource: DataSource) {
  return (model: string) => new PostgresAdapter(model, dataSource);
}
