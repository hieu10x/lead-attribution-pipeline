import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { buildDeliveries } from "../../simulator/deliveries";
import { generateWorld } from "../../simulator/world";
import { SECRET, ctx, envFor, resetData, setupDb } from "./helpers";

let sql: Awaited<ReturnType<typeof setupDb>>;
beforeAll(async () => {
  sql = await setupDb();
  await resetData(sql);
});
afterAll(async () => {
  await sql.end();
});

// One simulated day, chaos on, through the real endpoint into the real database.
describe("simulated traffic → POST /hooks → raw_events", () => {
  it("stores every event exactly once, despite retries and out-of-order arrival", async () => {
    const deliveries = buildDeliveries(generateWorld({ days: 1 }));
    const expectedKeys = new Set(deliveries.map((d) => d.key));
    const statuses = { stored: 0, duplicate: 0 };

    for (const d of deliveries) {
      const req = new Request(`http://test/hooks/${d.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": SECRET },
        body: JSON.stringify(d.body),
      });
      const res = await app.fetch(req, envFor(), ctx);
      expect(res.status, d.key).toBe(200);
      const json = (await res.json()) as { status: "stored" | "duplicate"; valid: boolean };
      expect(json.valid, d.key).toBe(true);
      statuses[json.status]++;
    }

    expect(statuses).toEqual({ stored: expectedKeys.size, duplicate: deliveries.length - expectedKeys.size });

    const rows = await sql<{ key: string; process_error: string | null }[]>`
      select source || ':' || source_event_id as key, process_error from raw_events`;
    expect(new Set(rows.map((r) => r.key))).toEqual(expectedKeys);
    expect(rows.filter((r) => r.process_error !== null)).toEqual([]);
  });
});
