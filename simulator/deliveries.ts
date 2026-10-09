import { messyPhone } from "./phones.ts";
import { createRng } from "./random.ts";
import type { Call, DniSession, Screening, World } from "./world.ts";

/**
 * How the world reaches the pipeline: as webhook requests, with the mess real senders add.
 *   - retries: the same event sent twice (senders retry on timeouts, even when we got it)
 *   - lateness: some events arrive minutes after later ones (queues, outages), so order isn't guaranteed
 *   - phone formats: each call's caller number in a random format (messyPhone)
 * The world itself is never changed here; only how and when it's delivered.
 */

export type HookPath = "call-platform" | "ai-screening" | "dni";

export interface Delivery {
  deliverAt: number; // when the sender sends it (epoch ms)
  path: HookPath; // POST /hooks/<path>
  body: object;
  /** `${source}:${sourceEventId}`, the same key the database uses to spot duplicates. */
  key: string;
}

export interface ChaosConfig {
  duplicateRate: number; // share of events sent twice
  lateRate: number; // share of events delayed 1–120 minutes
}

export const DEFAULT_CHAOS: ChaosConfig = { duplicateRate: 0.1, lateRate: 0.05 };

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Event = Omit<Delivery, "deliverAt"> & { occurredAt: number };

export function buildDeliveries(world: World, chaos: Partial<ChaosConfig> = {}): Delivery[] {
  const { duplicateRate, lateRate } = { ...DEFAULT_CHAOS, ...chaos };
  // A separate random stream from the world's: changing chaos settings never changes what happened.
  const rng = createRng(world.config.seed + 1_000_003);

  const events: Event[] = [];
  for (const s of world.sessions) events.push(dniEvent(s));
  for (const c of world.calls) {
    const callerNumber = messyPhone(c.callerPhone, rng); // one format per call, kept across its events
    events.push(...callEvents(c, callerNumber));
    if (c.screening) events.push(screeningEvent(c, c.screening));
  }

  const deliveries: Delivery[] = [];
  for (const { occurredAt, ...e } of events) {
    const delay = rng.chance(lateRate) ? rng.int(1, 120) * MINUTE : rng.int(0, 5) * 1000;
    const first: Delivery = { ...e, deliverAt: occurredAt + delay };
    deliveries.push(first);
    if (rng.chance(duplicateRate)) deliveries.push({ ...first, deliverAt: first.deliverAt + rng.int(1, 600) * 1000 });
  }
  return deliveries.sort((a, b) => a.deliverAt - b.deliverAt);
}

// ── Payloads, shaped like each real sender's webhook (see src/ingest/schemas.ts) ─────────────────

function dniEvent(s: DniSession): Event {
  return {
    occurredAt: s.assignedAt,
    path: "dni",
    key: `dni:${s.sessionId}`,
    body: {
      sessionId: s.sessionId,
      trackingNumber: s.trackingNumber,
      assignedAt: iso(s.assignedAt),
      campaignId: s.ad.campaignId,
      adsetId: s.ad.adsetId,
      adId: s.ad.adId,
      ...(s.fbc !== null && { fbc: s.fbc }),
      fbp: s.fbp,
      landingPage: s.landingPage,
    },
  };
}

/** Ringba-like lifecycle: incoming → connected (only if a buyer answered) → completed. */
function callEvents(c: Call, callerNumber: string): Event[] {
  const event = (name: string, at: number, extra: object = {}): Event => ({
    occurredAt: at,
    path: "call-platform",
    key: `call_platform:${c.callId}:${name}`,
    body: { event: name, callId: c.callId, trackingNumber: c.trackingNumber, callerNumber, timestamp: iso(at), ...extra },
  });
  const buyer = c.buyerId !== null ? { buyerId: c.buyerId } : {};
  return [
    event("incoming", c.startedAt),
    ...(c.connectedAt !== null ? [event("connected", c.connectedAt, buyer)] : []),
    event("completed", c.endedAt, { durationSec: c.durationSec, ...buyer }), // durationSec = talk time with the buyer
  ];
}

/** Vapi-like end-of-call report. Vapi always sends E.164, so no messy phone here. */
function screeningEvent(c: Call, s: Screening): Event {
  return {
    occurredAt: s.endedAt,
    path: "ai-screening",
    key: `ai_screening:${s.screeningId}`,
    body: {
      message: {
        type: "end-of-call-report",
        call: { id: s.screeningId, customer: { number: c.callerPhone }, metadata: { platformCallId: c.callId } },
        endedReason: s.endedReason,
        endedAt: iso(s.endedAt),
        analysis: {
          summary: `${s.qualified ? "Qualified" : "Not qualified"}: ${s.service} caller in ${s.zip}.`,
          structuredData: { qualified: s.qualified, service: s.service, zip: s.zip },
        },
      },
    },
  };
}
