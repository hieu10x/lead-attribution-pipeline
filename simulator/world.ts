import { createRng } from "./random.ts";

/**
 * The simulated "true world" of RoofCall: who clicked which ad, who called, what the AI screener
 * decided, and what the buyer's CRM recorded days later.
 *
 * This file only knows what *really happened*. How events reach the pipeline (as webhooks, late,
 * twice, with messy phone formats) is decided separately in deliveries.ts. That split is what lets
 * the simulator know the correct answers even when delivery is chaotic.
 *
 * Times are epoch milliseconds; phones are E.164 (+1XXXXXXXXXX). Messiness is added on delivery.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── Fixed business setup ────────────────────────────────────────────────────────────────────────
export type Service = "roofing" | "hvac";

export interface Ad {
  campaignId: string;
  adsetId: string;
  adId: string;
  service: Service;
}

/** Each campaign also has a static number (Google listing, flyers): calls to it have no click. */
export const CAMPAIGNS = [
  { campaignId: "cmp_roof_storm", service: "roofing", staticNumber: "+15125550100" },
  { campaignId: "cmp_roof_replace", service: "roofing", staticNumber: "+15125550101" },
  { campaignId: "cmp_hvac_tuneup", service: "hvac", staticNumber: "+15125550102" },
] as const;

/** 3 campaigns × 2 ad sets × 2 ads = 12 ads. */
export const ADS: readonly Ad[] = CAMPAIGNS.flatMap((c) =>
  [1, 2].flatMap((s) =>
    [1, 2].map((a) => ({
      campaignId: c.campaignId,
      adsetId: `${c.campaignId}_as${s}`,
      adId: `${c.campaignId}_as${s}_ad${a}`,
      service: c.service,
    })),
  ),
);

/** Tracking numbers that DNI hands out to website visitors, one visitor at a time. */
export const DNI_POOL: readonly string[] = Array.from({ length: 40 }, (_, i) => `+1512555${String(200 + i).padStart(4, "0")}`);

/** A number no longer used by any campaign: calls to it can't be attributed at all. */
export const RETIRED_NUMBER = "+15125550999";

/** How long a DNI number stays reserved for one visitor. Nobody else gets it during this time. */
export const HOLD_MINUTES = 30;

const BUYERS: Record<Service, readonly string[]> = {
  roofing: ["buyer_lonestar_roofing", "buyer_hill_country_roofing"],
  hvac: ["buyer_cool_breeze_hvac"],
};
const AREA_CODES = ["512", "737", "210", "214", "469", "713"];
const ZIPS = ["78701", "78704", "78745", "78613", "78660", "78228"];

// ── Configuration ───────────────────────────────────────────────────────────────────────────────
export interface SimConfig {
  seed: number;
  start: string; // first simulated day, e.g. "2026-09-01" (UTC midnight)
  days: number;
  clicksPerDay: number;
  callRate: number; // share of clicks that lead to a call
  staticCallsPerDay: number; // calls to a campaign's static number (no click behind them)
  unknownCallsPerDay: number; // calls to the retired number
  repeatCallerRate: number; // share of calls from someone who already called in the last 30 days
  screenedRate: number; // share of calls that talk to the AI screener before a buyer
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 42,
  start: "2026-09-01",
  days: 30,
  clicksPerDay: 200,
  callRate: 0.08,
  staticCallsPerDay: 2,
  unknownCallsPerDay: 0.3,
  repeatCallerRate: 0.08,
  screenedRate: 0.5,
};

// ── What the world contains ─────────────────────────────────────────────────────────────────────
export interface DniSession {
  sessionId: string;
  trackingNumber: string;
  assignedAt: number;
  ad: Ad;
  fbc: string | null; // Meta click id cookie; missing when the click had no fbclid
  fbp: string; // Meta browser id cookie
  landingPage: string;
}

export interface Screening {
  screeningId: string;
  qualified: boolean;
  service: Service;
  zip: string;
  endedReason: string;
  endedAt: number;
}

export interface Call {
  callId: string;
  trackingNumber: string;
  callerPhone: string;
  startedAt: number;
  endedAt: number;
  sessionId: string | null; // truth: the click behind this call (null = no click)
  campaignId: string | null; // truth: the campaign that owns the dialed number (null = unknown)
  service: Service;
  screening: Screening | null; // null = went straight to a buyer
  buyerId: string | null; // null = never connected to a buyer
  connectedAt: number | null;
  durationSec: number; // talk time with the buyer; 0 if not connected
}

export type CrmStage =
  | { stage: "appointment"; at: number }
  | { stage: "sold"; at: number; value: number }
  | { stage: "lost"; at: number };

/** A record in the buyer's CRM. The buyer doesn't know our callId; the phone is the only link. */
export interface CrmRecord {
  recordId: string;
  buyerId: string;
  phone: string;
  createdAt: number;
  stages: CrmStage[]; // in time order; may extend past the simulated period
  callId: string; // truth only: never exposed by the mock CRM API
}

export interface World {
  config: SimConfig;
  sessions: DniSession[];
  calls: Call[]; // in time order
  crm: CrmRecord[];
}

// ── Generation ──────────────────────────────────────────────────────────────────────────────────
interface CallIntent {
  at: number;
  trackingNumber: string;
  sessionId: string | null;
  campaignId: string | null;
  service: Service;
}

export function generateWorld(overrides: Partial<SimConfig> = {}): World {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const rng = createRng(config.seed);
  const t0 = Date.parse(config.start);

  // The seed is part of every id, so two simulator runs with different seeds never collide in the DB.
  let seq = 0;
  const id = (prefix: string) => `${prefix}_s${config.seed}_${String(++seq).padStart(6, "0")}`;

  /** Rounds a fractional daily rate to a whole count: 0.3/day → 1 on ~30% of days. */
  const countFor = (rate: number) => Math.floor(rate) + (rng.chance(rate % 1) ? 1 : 0);
  /** A random moment in US Central business hours (08:00–22:00 CDT = 13:00–03:00 UTC). */
  const businessHours = (dayStart: number) => dayStart + 13 * HOUR + rng.int(0, 14 * HOUR - 1);
  const newPhone = () =>
    `+1${rng.pick(AREA_CODES)}${rng.int(200, 999)}${String(rng.int(0, 9999)).padStart(4, "0")}`;

  const sessions: DniSession[] = [];
  const calls: Call[] = [];
  const crm: CrmRecord[] = [];
  const numberHeldUntil = new Map<string, number>();

  /** Least-recently-used DNI number that's free at `at`, like real DNI pools. */
  const freeDniNumber = (at: number): string | null => {
    let best: string | null = null;
    let bestUntil = Infinity;
    for (const n of DNI_POOL) {
      const until = numberHeldUntil.get(n) ?? 0;
      if (until <= at && until < bestUntil) [best, bestUntil] = [n, until];
    }
    return best;
  };

  const pickCaller = (at: number): string => {
    const recent = calls.filter((c) => at - c.startedAt <= 30 * DAY);
    if (recent.length > 0 && rng.chance(config.repeatCallerRate)) return rng.pick(recent).callerPhone;
    return newPhone();
  };

  const placeCall = (intent: CallIntent) => {
    const callerPhone = pickCaller(intent.at);
    let t = intent.at;

    let screening: Screening | null = null;
    if (rng.chance(config.screenedRate)) {
      t += rng.int(30, 150) * 1000;
      const qualified = rng.chance(0.7);
      screening = {
        screeningId: id("scr"),
        qualified,
        service: intent.service,
        zip: rng.pick(ZIPS),
        endedReason: qualified ? "assistant-forwarded-call" : rng.pick(["customer-ended-call", "assistant-ended-call"]),
        endedAt: t,
      };
    }

    // Unqualified callers are never forwarded; otherwise a buyer answers 85% of the time.
    const connected = (screening === null || screening.qualified) && rng.chance(0.85);
    const connectedAt = connected ? t + rng.int(5, 25) * 1000 : null;
    // 40% of connected calls are short hang-ups; the 89s/90s boundary is reachable on purpose.
    const durationSec = connected ? (rng.chance(0.4) ? rng.int(10, 89) : rng.int(90, 900)) : 0;
    const endedAt = connectedAt !== null ? connectedAt + durationSec * 1000 : t + rng.int(5, 40) * 1000;
    const buyerId = connected ? rng.pick(BUYERS[intent.service]) : null;

    const call: Call = {
      callId: id("call"),
      trackingNumber: intent.trackingNumber,
      callerPhone,
      startedAt: intent.at,
      endedAt,
      sessionId: intent.sessionId,
      campaignId: intent.campaignId,
      service: intent.service,
      screening,
      buyerId,
      connectedAt,
      durationSec,
    };
    calls.push(call);

    // The buyer logs real conversations (60s+) in their CRM, then updates it over the next days.
    if (buyerId !== null && durationSec >= 60) crm.push(crmRecordFor(call, buyerId));
  };

  const crmRecordFor = (call: Call, buyerId: string): CrmRecord => {
    const createdAt = call.endedAt + rng.int(1, 30) * MINUTE;
    const stages: CrmStage[] = [];
    if (rng.chance(0.4)) {
      const apptAt = createdAt + rng.int(1, 3) * DAY + rng.int(0, 8) * HOUR;
      stages.push({ stage: "appointment", at: apptAt });
      const closedAt = apptAt + rng.int(2, 7) * DAY;
      if (rng.chance(0.35)) {
        const value = call.service === "roofing" ? rng.int(30, 150) * 100 : rng.int(8, 60) * 100;
        stages.push({ stage: "sold", at: closedAt, value });
      } else {
        stages.push({ stage: "lost", at: closedAt });
      }
    } else if (rng.chance(0.5)) {
      stages.push({ stage: "lost", at: createdAt + rng.int(1, 4) * DAY });
    } // else: the buyer never updates it, which real CRMs are full of
    return { recordId: id("crm"), buyerId, phone: call.callerPhone, createdAt, stages, callId: call.callId };
  };

  for (let d = 0; d < config.days; d++) {
    const dayStart = t0 + d * DAY;
    const intents: CallIntent[] = [];

    // 1. Ad clicks: each visitor gets a DNI number reserved for HOLD_MINUTES; some of them call it.
    const clickTimes = Array.from({ length: config.clicksPerDay }, () => businessHours(dayStart)).sort((a, b) => a - b);
    for (const at of clickTimes) {
      const trackingNumber = freeDniNumber(at);
      if (trackingNumber === null) continue; // pool exhausted: this visitor sees no tracking number
      const ad = rng.pick(ADS);
      numberHeldUntil.set(trackingNumber, at + HOLD_MINUTES * MINUTE);
      const session: DniSession = {
        sessionId: id("sess"),
        trackingNumber,
        assignedAt: at,
        ad,
        fbc: rng.chance(0.8) ? `fb.1.${at}.IwAR${rng.int(1e8, 1e9)}` : null,
        fbp: `fb.1.${at}.${rng.int(1e9, 9e9)}`,
        landingPage: `https://roofcall.example/${ad.service}?utm_campaign=${ad.campaignId}`,
      };
      sessions.push(session);
      if (rng.chance(config.callRate)) {
        // Calls land while the number is still reserved, so the match is unambiguous.
        intents.push({
          at: at + rng.int(1, HOLD_MINUTES - 5) * MINUTE,
          trackingNumber,
          sessionId: session.sessionId,
          campaignId: ad.campaignId,
          service: ad.service,
        });
      }
    }

    // 2. Calls without a click: a campaign's static number, or the retired number.
    for (let i = countFor(config.staticCallsPerDay); i > 0; i--) {
      const c = rng.pick(CAMPAIGNS);
      intents.push({ at: businessHours(dayStart), trackingNumber: c.staticNumber, sessionId: null, campaignId: c.campaignId, service: c.service });
    }
    for (let i = countFor(config.unknownCallsPerDay); i > 0; i--) {
      intents.push({ at: businessHours(dayStart), trackingNumber: RETIRED_NUMBER, sessionId: null, campaignId: null, service: rng.pick(["roofing", "hvac"] as const) });
    }

    // 3. Place the day's calls in time order, so "repeat caller" always means an *earlier* call.
    intents.sort((a, b) => a.at - b.at).forEach(placeCall);
  }

  return { config, sessions, calls, crm };
}
