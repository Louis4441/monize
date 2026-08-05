import { Logger } from "@nestjs/common";
import { Client } from "pg";

/**
 * Demo-mode startup probe: exits 0 when the demo user already exists (the
 * entrypoint then skips seeding) and 1 when it does not, or when the check
 * itself could not run -- seeding is idempotent, so a failed probe re-seeds
 * rather than leaving a demo deployment empty.
 *
 * This used to be a `node -e` blob inside docker-entrypoint.sh with `echo`
 * around it, which put four unformatted lines at the top of every demo
 * startup. As a compiled script it logs through the Nest `Logger` like the
 * rest of the boot sequence.
 */
const logger = new Logger("DbDemoCheck");

const DEMO_USER_EMAIL = "demo@monize.com";

export async function demoUserExists(): Promise<boolean> {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  await client.connect();
  try {
    const result = await client.query("SELECT id FROM users WHERE email = $1", [
      DEMO_USER_EMAIL,
    ]);
    return result.rows.length > 0;
  } finally {
    await client.end();
  }
}

/**
 * Probe entry point. Exported so the spec can drive all three outcomes
 * (present, absent, unreachable) without spawning the script.
 */
export async function checkDemoUser(): Promise<void> {
  logger.log("Demo mode detected; checking whether the demo user exists");
  let exists: boolean;
  try {
    exists = await demoUserExists();
  } catch (error) {
    logger.warn(
      `Could not check for the demo user (${
        error instanceof Error ? error.message : String(error)
      }); seeding will be attempted`,
    );
    process.exit(1);
  }

  if (exists) {
    logger.log("Demo user already exists; skipping seed");
    process.exit(0);
  }

  logger.log("Demo user not found; seeding demo data");
  process.exit(1);
}

if (require.main === module) {
  checkDemoUser();
}
