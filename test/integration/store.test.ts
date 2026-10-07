import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invalidEventMeta, storeRawEvent } from "../../src/ingest/store";
import { resetData, setupDb } from "./helpers";

let sql: Awaited<ReturnType<typeof setupDb>>;
// Note: hooks use braces on purpose. Vitest treats a function returned from beforeAll as a teardown
// callback, and the postgres client *is* a function, so `async () => (sql = …)` would be called as one.
beforeAll(async () => {
  sql = await setupDb();
});
beforeEach(async () => {
  await resetData(sql);
});
afterAll(async () => {
  await sql.end();
});

const meta = { sourceEventId: "CA123:completed", eventType: "call.completed", occurredAt: "2026-10-07T14:03:00Z" };

describe("storeRawEvent", () => {
  it("stores a new event, then reports the same event as a duplicate", async () => {
    const first = await storeRawEvent(sql, { source: "call_platform", meta, payload: { callId: "CA123" } });
    expect(first.status).toBe("stored");
    const second = await storeRawEvent(sql, { source: "call_platform", meta, payload: { callId: "CA123" } });
    expect(second).toEqual({ status: "duplicate" });
    const [row] = await sql`select count(*)::int as n from raw_events`;
    expect(row?.n).toBe(1);
  });

  it("treats the same id from a different source as a different event", async () => {
    await storeRawEvent(sql, { source: "call_platform", meta, payload: {} });
    const other = await storeRawEvent(sql, { source: "ai_screening", meta, payload: {} });
    expect(other.status).toBe("stored");
  });

  it("keeps the payload exactly as received, and the occurredAt timestamp", async () => {
    const payload = { callId: "CA123", nested: { a: [1, 2] }, unicode: "Nguyễn" };
    await storeRawEvent(sql, { source: "call_platform", meta, payload });
    const [row] = await sql`select payload, occurred_at from raw_events`;
    expect(row?.payload).toEqual(payload);
    expect((row?.occurred_at as Date).toISOString()).toBe("2026-10-07T14:03:00.000Z");
  });

  it("stores an invalid payload with its error, deduplicated by body hash", async () => {
    const body = '{"event":"exploded"}';
    const m = await invalidEventMeta(body);
    expect(m.sourceEventId).toMatch(/^invalid:[0-9a-f]{64}$/);
    await storeRawEvent(sql, { source: "call_platform", meta: m, payload: JSON.parse(body), error: "bad event" });
    const again = await storeRawEvent(sql, { source: "call_platform", meta: await invalidEventMeta(body), payload: {}, error: "x" });
    expect(again.status).toBe("duplicate");
    const [row] = await sql`select event_type, process_error from raw_events`;
    expect(row).toEqual({ event_type: "invalid", process_error: "bad event" });
  });
});
