import { describe, expect, it } from "vitest";
import { normalizeUsPhone } from "../../src/domain/phone";
import { DNI_POOL, HOLD_MINUTES, generateWorld } from "../../simulator/world";

const world = generateWorld(); // default: seed 42, 30 days

describe("generateWorld", () => {
  it("is reproducible: same seed → same world, different seed → different world", () => {
    expect(generateWorld({ days: 3 })).toEqual(generateWorld({ days: 3 }));
    expect(generateWorld({ days: 3, seed: 7 }).calls).not.toEqual(generateWorld({ days: 3 }).calls);
  });

  it("produces roughly the configured volume", () => {
    const { days, clicksPerDay, callRate } = world.config;
    expect(world.sessions).toHaveLength(days * clicksPerDay); // the pool of 40 never runs out at 200/day
    const clickCalls = world.calls.filter((c) => c.sessionId !== null).length;
    expect(clickCalls / world.sessions.length).toBeGreaterThan(callRate * 0.8);
    expect(clickCalls / world.sessions.length).toBeLessThan(callRate * 1.2);
  });

  it("only uses valid E.164 phone numbers (messiness is added later, on delivery)", () => {
    for (const c of world.calls) {
      expect(normalizeUsPhone(c.callerPhone)).toBe(c.callerPhone);
      expect(normalizeUsPhone(c.trackingNumber)).toBe(c.trackingNumber);
    }
    expect(new Set(DNI_POOL).size).toBe(40);
  });

  // The attribution rule in M3 relies on this: "the session holding the dialed number at call time".
  it("makes every click-driven call unambiguous: nobody else held that number in between", () => {
    const sessionsById = new Map(world.sessions.map((s) => [s.sessionId, s]));
    for (const call of world.calls.filter((c) => c.sessionId !== null)) {
      const session = sessionsById.get(call.sessionId!)!;
      expect(call.trackingNumber).toBe(session.trackingNumber);
      expect(call.startedAt - session.assignedAt).toBeLessThan(HOLD_MINUTES * 60_000);
      const competitors = world.sessions.filter(
        (s) => s.trackingNumber === call.trackingNumber && s.assignedAt > session.assignedAt && s.assignedAt <= call.startedAt,
      );
      expect(competitors).toEqual([]);
    }
  });

  it("follows the business rules of the call flow", () => {
    expect(world.calls.map((c) => c.startedAt)).toEqual(world.calls.map((c) => c.startedAt).sort((a, b) => a - b));
    for (const c of world.calls) {
      if (c.screening && !c.screening.qualified) expect(c.buyerId).toBeNull(); // never forwarded
      if (c.buyerId === null) expect(c.durationSec).toBe(0);
    }
  });

  it("includes the messy cases the pipeline must handle", () => {
    const phones = world.calls.map((c) => c.callerPhone);
    expect(new Set(phones).size).toBeLessThan(phones.length); // repeat callers
    expect(world.calls.some((c) => c.sessionId === null && c.campaignId !== null)).toBe(true); // static number
    expect(world.calls.some((c) => c.campaignId === null)).toBe(true); // retired number
    expect(world.calls.some((c) => c.durationSec === 89 || c.durationSec === 90)).toBe(true); // billing edge
    expect(world.crm.some((r) => r.stages.some((s) => s.stage === "sold"))).toBe(true);
    expect(world.crm.some((r) => r.stages.length === 0)).toBe(true); // buyer never updated it
  });
});
