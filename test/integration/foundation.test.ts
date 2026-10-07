import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { migrate } from "../../scripts/migrate.ts";
import { DATABASE_URL, resetData, setupDb } from "./helpers";

let sql: Awaited<ReturnType<typeof setupDb>>;

beforeAll(async () => {
  sql = await setupDb();
});
beforeEach(async () => {
  await resetData(sql);
});
afterAll(async () => {
  await sql.end();
});

describe("migrations", () => {
  it("are idempotent: a second run applies nothing", async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});

describe("raw_events", () => {
  it("ignores a duplicate (source, source_event_id) so webhook retries are safe", async () => {
    const insert = () => sql`
      insert into raw_events (source, source_event_id, event_type, payload)
      values ('call_platform', 'call-123:completed', 'call.completed', ${sql.json({ duration: 95 })})
      on conflict (source, source_event_id) do nothing
      returning id`;
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
    const [row] = await sql`select count(*)::int as count from raw_events`;
    expect(row?.count).toBe(1);
  });
});

describe("job_runs", () => {
  it("rejects unknown statuses", async () => {
    await expect(
      sql`insert into job_runs (job_name, trigger, status) values ('x', 'test', 'done')`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe("GET /health/db", () => {
  it("reaches the database", async () => {
    const env = { HYPERDRIVE: { connectionString: DATABASE_URL } } as unknown as Env;
    const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request("http://test/health/db"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
