import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { MAX_BODY_BYTES } from "../../src/routes/hooks";
import { SECRET, ctx, envFor, resetData, setupDb } from "./helpers";

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

function post(path: string, body: string | object, { secret = SECRET, env = envFor() } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-webhook-secret"] = secret;
  const init = { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) };
  return app.fetch(new Request(`http://test/hooks/${path}`, init), env, ctx);
}

const callEvent = {
  event: "completed",
  callId: "CA123",
  trackingNumber: "+15125550100",
  callerNumber: "(512) 555-0134",
  timestamp: "2026-10-07T14:03:00Z",
  durationSec: 95,
};

const count = async () => (await sql`select count(*)::int as n from raw_events`)[0]?.n;

describe("POST /hooks/:source", () => {
  it("stores a valid event, then answers a retry with 'duplicate'", async () => {
    const r1 = await post("call-platform", callEvent);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ status: "stored", valid: true });
    const r2 = await post("call-platform", callEvent);
    expect(await r2.json()).toEqual({ status: "duplicate", valid: true });
    expect(await count()).toBe(1);
  });

  it("rejects a wrong or missing secret with 401 and stores nothing", async () => {
    expect((await post("call-platform", callEvent, { secret: "nope" })).status).toBe(401);
    expect((await post("call-platform", callEvent, { secret: "" })).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it("stores an invalid payload from a trusted sender, flagged, with 200", async () => {
    const r = await post("call-platform", { ...callEvent, event: "exploded" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "stored", valid: false });
    const [row] = await sql`select event_type, process_error from raw_events`;
    expect(row?.event_type).toBe("invalid");
    expect(row?.process_error).toMatch(/event/);
  });

  it("stores a non-JSON body as raw text, flagged", async () => {
    const r = await post("dni", "this is not json");
    expect(await r.json()).toEqual({ status: "stored", valid: false });
    const [row] = await sql`select payload, process_error from raw_events`;
    expect(row?.payload).toEqual({ _raw: "this is not json" });
    expect(row?.process_error).toBe("body is not valid JSON");
  });

  it("returns 404 for an unknown source", async () => {
    expect((await post("fax-machine", callEvent)).status).toBe(404);
  });

  it("returns 413 for an oversized body and stores nothing", async () => {
    const big = JSON.stringify({ ...callEvent, padding: "x".repeat(MAX_BODY_BYTES) });
    expect((await post("call-platform", big)).status).toBe(413);
    expect(await count()).toBe(0);
  });

  it("returns 503 when the database is unreachable, so the sender retries", async () => {
    const r = await post("call-platform", callEvent, { env: envFor("postgres://lap:lap@127.0.0.1:1/lap") });
    expect(r.status).toBe(503);
  });
});
