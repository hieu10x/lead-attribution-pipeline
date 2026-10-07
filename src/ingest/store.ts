import type { Sql } from "../db/client";
import type { EventMeta, Source } from "./schemas";

export type StoreResult = { status: "stored"; id: number } | { status: "duplicate" };

export interface RawEventInput {
  source: Source;
  meta: EventMeta;
  payload: unknown;
  /** Set when the payload failed validation: it's stored for inspection/replay but never processed as-is. */
  error?: string;
}

/**
 * Inserts an event into raw_events exactly once.
 * A repeat of the same (source, sourceEventId) is a no-op that reports "duplicate", which is how webhook retries stay harmless.
 */
export async function storeRawEvent(sql: Sql, e: RawEventInput): Promise<StoreResult> {
  const rows = await sql`
    insert into raw_events (source, source_event_id, event_type, occurred_at, payload, process_error)
    values (${e.source}, ${e.meta.sourceEventId}, ${e.meta.eventType}, ${e.meta.occurredAt},
            ${sql.json(e.payload as never)}, ${e.error ?? null})
    on conflict (source, source_event_id) do nothing
    returning id`;
  const row = rows[0];
  return row ? { status: "stored", id: Number(row.id) } : { status: "duplicate" };
}

/**
 * Envelope for a payload that failed validation (or wasn't JSON).
 * The id is a hash of the raw body, so the sender retrying the same bad payload doesn't create duplicates.
 */
export async function invalidEventMeta(rawBody: string): Promise<EventMeta> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { sourceEventId: `invalid:${hex}`, eventType: "invalid", occurredAt: null };
}
