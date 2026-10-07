import { Hono } from "hono";
import { createSql } from "./db/client";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "lead-attribution-pipeline" }));

// Checks the database round trip through Hyperdrive (or the local connection string in dev).
app.get("/health/db", async (c) => {
  const sql = createSql(c.env.HYPERDRIVE.connectionString);
  try {
    const [row] = await sql`select now() as db_time`;
    return c.json({ ok: true, db_time: row?.db_time });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
});

export default {
  fetch: app.fetch,
  // Cron jobs are registered from M1 onwards (process-events, crm-poll, capi-dispatch, daily-feed, watchdog).
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;

export { app };
