import { Cron } from "@nestjs/schedule";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { derivePurposeKey } from "../auth/crypto.util";

export const CHART_TOKEN_TTL_MS = 5 * 60_000;
export const CHART_ARTIFACT_LIMIT = 1000;
export const CHART_MAX_BYTES = 64 * 1024;
export const CHART_TOKEN_PATTERN = /^[a-f0-9]{64}\.[0-9]{13}\.[a-f0-9]{64}$/;

@Injectable()
export class PushChartArtifactService {
  private readonly key: string | null;
  private readonly logger = new Logger(PushChartArtifactService.name);
  constructor(
    private readonly db: DataSource,
    config: ConfigService,
  ) {
    const secret = config.get<string>("JWT_SECRET");
    this.key = secret ? derivePurposeKey(secret, "push-chart-artifact") : null;
  }
  @Cron("*/5 * * * *")
  async cleanup(): Promise<void> {
    try {
      await withSystemContext(() =>
        withScopedDb(this.db, (m) =>
          m.query(
            "DELETE FROM push_chart_artifacts WHERE expires_at <= CURRENT_TIMESTAMP",
          ),
        ),
      );
    } catch {
      this.logger.warn("Expired push chart cleanup failed");
    }
  }
  private sign(value: string): string {
    return createHmac("sha256", this.key!).update(value).digest("hex");
  }
  /** Called only by the opted-in price push fan-out, once per target device. */
  async issue(png: Buffer): Promise<string | null> {
    if (
      !this.key ||
      png.length > CHART_MAX_BYTES ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return null;
    const nonce = randomBytes(32).toString("hex");
    const expires = Date.now() + CHART_TOKEN_TTL_MS;
    const inserted = await withSystemContext(() =>
      withScopedDb(this.db, async (m) => {
        // Serialize quota decisions across replicas. The cap also bounds cleanup.
        await m.query(
          "SELECT pg_advisory_xact_lock(hashtext('monize.push-chart-cap'))",
        );
        await m.query(
          "DELETE FROM push_chart_artifacts WHERE expires_at <= CURRENT_TIMESTAMP",
        );
        const rows = await m.query(
          `INSERT INTO push_chart_artifacts (id, expires_at, png)
        SELECT $1, $2, $3 WHERE (SELECT COUNT(*) FROM push_chart_artifacts) < $4 RETURNING id`,
          [nonce, new Date(expires), png, CHART_ARTIFACT_LIMIT],
        );
        return rows.length > 0;
      }),
    );
    if (!inserted) return null;
    const value = `${nonce}.${expires}`;
    return `/api/v1/push/chart/${value}.${this.sign(value)}.png`;
  }
  /** Signature/TTL checked before DB access; DELETE RETURNING is the one-use gate. */
  async consume(token: string): Promise<Buffer | null> {
    if (!this.key || !CHART_TOKEN_PATTERN.test(token)) return null;
    const [nonce, expiry, signature] = token.split(".");
    if (Number(expiry) <= Date.now()) return null;
    const expected = Buffer.from(this.sign(`${nonce}.${expiry}`), "hex");
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
    const rows = await withSystemContext(() =>
      withScopedDb(this.db, async (m) =>
        returnedRows<{ png: Buffer }>(
          await m.query(
            `DELETE FROM push_chart_artifacts
        WHERE id = $1 AND expires_at = $2 AND expires_at > CURRENT_TIMESTAMP RETURNING png`,
            [nonce, new Date(Number(expiry))],
          ),
        ),
      ),
    );
    return rows[0]?.png ?? null;
  }
}
