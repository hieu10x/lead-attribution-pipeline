import postgres from "postgres";
import { LOCAL_DATABASE_URL, migrate } from "../../scripts/migrate.ts";

export const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

/** Connects to the test database, applies migrations and returns a client. Run `pnpm db:up` first locally. */
export async function setupDb() {
  const sql = postgres(DATABASE_URL, { onnotice: () => {}, max: 3 });
  await migrate(sql);
  return sql;
}

/** Empties data tables between tests (keeps schema_migrations). */
export async function resetData(sql: ReturnType<typeof postgres>) {
  await sql`truncate raw_events, job_runs restart identity`;
}

// ── Calling the Worker in tests, with a fake Cloudflare environment ─────────────────────────────
export const SECRET = "test-secret";
export const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;
export const envFor = (connectionString = DATABASE_URL) =>
  ({ HYPERDRIVE: { connectionString }, WEBHOOK_SECRET: SECRET, DRY_RUN: "true" }) as unknown as Env;
