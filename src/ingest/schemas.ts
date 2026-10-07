import { z } from "zod";

/**
 * What we must learn from any incoming event before storing it.
 * The full payload is always stored as received; this is only the "envelope".
 */
export interface EventMeta {
  sourceEventId: string; // the sender's unique id for this event → our idempotency key
  eventType: string; // e.g. "call.completed"
  occurredAt: string | null; // when it happened at the source (ISO 8601)
}

/** Pairs a payload schema with the function that extracts the envelope from a valid payload. */
function defineSource<S extends z.ZodType>(schema: S, meta: (data: z.infer<S>) => EventMeta) {
  return { schema, meta };
}

// ── Call platform (Ringba-like): one webhook per call lifecycle event ──────────────────────────
// A call produces several events (incoming → connected → completed → …), so the idempotency key
// is callId + event name: the same event resent = duplicate; a new event for the same call = new row.
const callPlatformEvent = z.object({
  event: z.enum(["incoming", "connected", "completed", "converted", "payout", "finalized", "error"]),
  callId: z.string().min(1),
  trackingNumber: z.string().min(1),
  callerNumber: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  durationSec: z.number().int().nonnegative().optional(),
  buyerId: z.string().optional(),
  payout: z.number().nonnegative().optional(),
});

// ── AI screening (Vapi-like "end-of-call-report"): one report per screening call ───────────────
const aiScreeningReport = z.object({
  message: z.object({
    type: z.literal("end-of-call-report"),
    call: z.object({
      id: z.string().min(1),
      customer: z.object({ number: z.string() }).optional(),
    }),
    endedReason: z.string(),
    endedAt: z.iso.datetime({ offset: true }),
    analysis: z
      .object({
        summary: z.string().optional(),
        structuredData: z
          .object({ qualified: z.boolean(), service: z.string(), zip: z.string() })
          .partial()
          .optional(),
      })
      .optional(),
  }),
});

// ── DNI (dynamic number insertion): a website visitor session was given a tracking number ──────
const dniAssignment = z.object({
    sessionId: z.string().nonempty(),
    trackingNumber: z.string().nonempty(),
    assignedAt: z.iso.datetime({ offset: true }),
    campaignId: z.string().nonempty(),
    adsetId: z.string().nonempty(),
    adId: z.string().nonempty(),
    fbc: z.string().optional(),
    fbp: z.string().optional(),
    landingPage: z.url().optional()
});

export const SOURCES = {
  call_platform: defineSource(callPlatformEvent, (e) => ({
    sourceEventId: `${e.callId}:${e.event}`,
    eventType: `call.${e.event}`,
    occurredAt: e.timestamp,
  })),
  ai_screening: defineSource(aiScreeningReport, (r) => ({
    sourceEventId: r.message.call.id,
    eventType: "screening.report",
    occurredAt: r.message.endedAt,
  })),
  dni: defineSource(dniAssignment, (a) => ({
    sourceEventId: a.sessionId,
    eventType: "dni.assigned",
    occurredAt: a.assignedAt,
  })),
} as const;

export type Source = keyof typeof SOURCES;

export type ParseResult = { ok: true; meta: EventMeta } | { ok: false; error: string };

/** Validates a payload for a source. Never throws: invalid input becomes { ok: false, error }. */
export function parseEvent(source: Source, payload: unknown): ParseResult {
  const spec = SOURCES[source];
  const result = spec.schema.safeParse(payload);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
  return { ok: true, meta: spec.meta(result.data as never) };
}
