import { describe, expect, it } from "vitest";
import { parseEvent, type Source } from "../../src/ingest/schemas";
import { buildDeliveries } from "../../simulator/deliveries";
import { generateWorld } from "../../simulator/world";

const SOURCE_FOR_PATH: Record<string, Source> = { "call-platform": "call_platform", "ai-screening": "ai_screening", dni: "dni" };

const world = generateWorld({ days: 5 });
const deliveries = buildDeliveries(world);
const uniqueKeys = new Set(deliveries.map((d) => d.key));

describe("buildDeliveries", () => {
  it("is reproducible, and chaos settings don't change the world", () => {
    expect(buildDeliveries(world)).toEqual(deliveries);
    const calm = buildDeliveries(world, { duplicateRate: 0, lateRate: 0 });
    expect(new Set(calm.map((d) => d.key))).toEqual(uniqueKeys); // same events, only delivered differently
    expect(calm).toHaveLength(uniqueKeys.size);
  });

  // The key is how the test in 3b (and later ground truth) predicts what the database will contain.
  it("sends payloads the ingest endpoint accepts, with the key the database will use", () => {
    for (const d of deliveries) {
      const source = SOURCE_FOR_PATH[d.path]!;
      const parsed = parseEvent(source, d.body);
      if (!parsed.ok) throw new Error(`${d.key} rejected: ${parsed.error}`);
      expect(`${source}:${parsed.meta.sourceEventId}`).toBe(d.key);
    }
  });

  it("covers every session, call event and screening exactly once (before duplicates)", () => {
    const callEvents = world.calls.reduce((n, c) => n + 2 + (c.connectedAt !== null ? 1 : 0), 0);
    const screenings = world.calls.filter((c) => c.screening).length;
    expect(uniqueKeys.size).toBe(world.sessions.length + callEvents + screenings);
  });

  it("adds the chaos: ~10% retries, out-of-order arrivals, messy phone formats", () => {
    const retries = deliveries.length - uniqueKeys.size;
    expect(retries / uniqueKeys.size).toBeGreaterThan(0.07);
    expect(retries / uniqueKeys.size).toBeLessThan(0.13);

    const firstArrival = new Map<string, number>();
    for (const d of deliveries) if (!firstArrival.has(d.key)) firstArrival.set(d.key, d.deliverAt);
    const arrival = (key: string) => firstArrival.get(key)!;
    // a call that "completed" before it was "incoming"
    expect(world.calls.some((c) => arrival(`call_platform:${c.callId}:completed`) < arrival(`call_platform:${c.callId}:incoming`))).toBe(true);
    // a call that arrives before the website visit that led to it
    expect(world.calls.some((c) => c.sessionId && arrival(`dni:${c.sessionId}`) > arrival(`call_platform:${c.callId}:incoming`))).toBe(true);

    const callerNumbers = deliveries.filter((d) => d.path === "call-platform").map((d) => (d.body as { callerNumber: string }).callerNumber);
    expect(callerNumbers.some((n) => n.startsWith("("))).toBe(true);
    expect(callerNumbers.some((n) => n.startsWith("+1"))).toBe(true);
  });
});
