import { describe, expect, it } from "vitest";
import { parseEvent } from "../../src/ingest/schemas";

describe("call_platform", () => {
  const valid = {
    event: "completed",
    callId: "CA123",
    trackingNumber: "+15125550100",
    callerNumber: "(512) 555-0134",
    timestamp: "2026-10-07T14:03:00Z",
    durationSec: 95,
    buyerId: "buyer-7",
  };

  it("extracts callId:event as the idempotency key", () => {
    expect(parseEvent("call_platform", valid)).toEqual({
      ok: true,
      meta: { sourceEventId: "CA123:completed", eventType: "call.completed", occurredAt: "2026-10-07T14:03:00Z" },
    });
  });

  it("rejects an unknown event name with a readable error", () => {
    const r = parseEvent("call_platform", { ...valid, event: "exploded" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/event/);
  });

  it("rejects a negative duration", () => {
    expect(parseEvent("call_platform", { ...valid, durationSec: -5 }).ok).toBe(false);
  });

  it("never throws on garbage input", () => {
    for (const junk of [null, 42, "text", [], {}]) expect(parseEvent("call_platform", junk).ok).toBe(false);
  });
});

describe("ai_screening", () => {
  const valid = {
    message: {
      type: "end-of-call-report",
      call: { id: "vapi-call-9", customer: { number: "+15125550134" } },
      endedReason: "assistant-forwarded-call",
      endedAt: "2026-10-07T14:01:30Z",
      analysis: { summary: "Roof leak, wants quote", structuredData: { qualified: true, service: "roofing" } },
    },
  };

  it("uses the screening call id as the idempotency key", () => {
    expect(parseEvent("ai_screening", valid)).toEqual({
      ok: true,
      meta: { sourceEventId: "vapi-call-9", eventType: "screening.report", occurredAt: "2026-10-07T14:01:30Z" },
    });
  });

  it("accepts a report without analysis (e.g. caller hung up early)", () => {
    const { analysis: _drop, ...message } = valid.message;
    expect(parseEvent("ai_screening", { message }).ok).toBe(true);
  });

  it("rejects other Vapi message types", () => {
    expect(parseEvent("ai_screening", { message: { ...valid.message, type: "status-update" } }).ok).toBe(false);
  });
});

// ── YOUR PART: make these pass by implementing `dniAssignment` in src/ingest/schemas.ts ──────────
// Payload contract (what the landing page's tracking script sends when it assigns a number):
//   sessionId       string, required, non-empty     → idempotency key
//   trackingNumber  string, required, non-empty
//   assignedAt      ISO datetime, required           → occurredAt
//   campaignId, adsetId, adId   strings, required, nonempty
//   fbc, fbp        strings, optional (Meta click/browser ids; missing when cookies are blocked)
//   landingPage     URL string, optional
// eventType must be "dni.assigned".
describe("dni", () => {
  const valid = {
    sessionId: "sess-abc",
    trackingNumber: "+15125550100",
    assignedAt: "2026-10-07T13:58:10Z",
    campaignId: "cmp-1",
    adsetId: "as-1",
    adId: "ad-1",
    fbc: "fb.1.1759845490000.IwAR0abc",
  };

  it("uses sessionId as the idempotency key", () => {
    expect(parseEvent("dni", valid)).toEqual({
      ok: true,
      meta: { sourceEventId: "sess-abc", eventType: "dni.assigned", occurredAt: "2026-10-07T13:58:10Z" },
    });
  });

  it("accepts a session without fbc/fbp (cookies blocked)", () => {
    const { fbc: _drop, ...noCookies } = valid;
    expect(parseEvent("dni", noCookies).ok).toBe(true);
  });

  it("requires the ad ids (no ids = no attribution)", () => {
    const { adId: _drop, ...noAd } = valid;
    expect(parseEvent("dni", noAd).ok).toBe(false);
  });

  it("requires the ad ids not empty", () => {
    expect(parseEvent("dni", { ...valid, adId: "" }).ok).toBe(false);
  });

  it("rejects a malformed landingPage", () => {
    expect(parseEvent("dni", { ...valid, landingPage: "not a url" }).ok).toBe(false);
  });
});
