import { Hono } from "hono";
import { createSql } from "../db/client";
import { parseEvent, type Source } from "../ingest/schemas";
import { invalidEventMeta, storeRawEvent } from "../ingest/store";

/** URL path segment → internal source name. Anything else is a 404. */
const PATHS: Record<string, Source> = {
  "call-platform": "call_platform",
  "ai-screening": "ai_screening",
  dni: "dni",
};

export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Webhook ingestion. Response policy:
 *   401  wrong/missing secret       → store nothing (untrusted)
 *   413  body too large             → store nothing (protects DB and Worker limits)
 *   200  valid                      → stored | duplicate
 *   200  invalid but trusted sender → stored flagged (valid: false); a 4xx would make senders retry
 *                                     forever or disable the webhook, and we'd lose real data
 *   503  our database is down       → the sender SHOULD retry later, so nothing is lost
 */
export const hooks = new Hono<{ Bindings: Env }>();

hooks.post("/:path", async (c) => {
  const source = PATHS[c.req.param("path")];
  if (!source) return c.json({ error: "unknown source" }, 404);

  const expected = c.env.WEBHOOK_SECRET;
  if (!expected) return c.json({ error: "server misconfigured" }, 500); // fail closed
  if (!(await secretsMatch(c.req.header("x-webhook-secret"), expected))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  // Parse + validate. Failures don't throw; they become a flagged event.
  let payload: unknown;
  let parsed: ReturnType<typeof parseEvent>;
  try {
    payload = JSON.parse(rawBody);
    parsed = parseEvent(source, payload);
  } catch {
    payload = { _raw: rawBody };
    parsed = { ok: false, error: "body is not valid JSON" };
  }
  const meta = parsed.ok ? parsed.meta : await invalidEventMeta(rawBody);
  const error = parsed.ok ? undefined : parsed.error;

  const sql = createSql(c.env.HYPERDRIVE.connectionString);
  try {
    const result = await storeRawEvent(sql, { source, meta, payload, error });
    return c.json({ status: result.status, valid: parsed.ok });
  } catch (err) {
    console.error("ingest: store failed", source, (err as Error).message);
    return c.json({ error: "temporarily unavailable" }, 503);
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
});

/** Constant-time comparison (hash both sides first so lengths match), so response timing leaks nothing about the secret. */
async function secretsMatch(given: string | undefined, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
