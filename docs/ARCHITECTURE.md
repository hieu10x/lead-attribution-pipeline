# Architecture

A reliable lead/call **outcome attribution pipeline** for a pay-per-call lead-generation business, built on Cloudflare Workers + Postgres. All data is synthetic (see the simulator).

## 1. Scenario (fictional, realistic)
**"RoofCall"**, a pay-per-call lead-generation company for home services (roofing, HVAC).

```
Meta ad click ──► landing page (DNI assigns a tracking number to the visitor session, storing fbc/fbp/ad ids)
       │
       ▼
Homeowner calls tracking number ──► Call platform (Ringba-like) routes the call
       │                                 │
       │                       (optional) AI pre-qualifier (Vapi-like) screens the caller
       │                                 │
       ▼                                 ▼
Connected to buyer (contractor) ──► billable if duration ≥ 90s and not a repeat caller within 30 days
       │
       ▼
Buyer's CRM, days later: appointment booked ──► job sold ($ value)
```

**Business questions the system answers:**
- Which ads produce **sold jobs**, not just calls?
- What is the true cost per sold job and the return on ad spend, by campaign, ad set and ad?
- Does Meta's algorithm get told about the outcomes that matter (qualified call → appointment → sale), so it optimizes for revenue instead of cheap calls?

## 2. Architecture

```
            ┌───────────────────────── Simulator (separate Worker / script) ──────────────────────────┐
            │  clicks + DNI sessions · call events · AI screening reports · mock CRM API (OAuth)     │
            │  chaos knobs: duplicates, out-of-order, bad phone formats, 5xx, 429, token expiry, late │
            └──────────┬──────────────────────────┬───────────────────────────┬──────────────────────┘
                       │ webhooks                 │ webhooks                  │ polled API
                       ▼                          ▼                           ▼
┌──────────────────────────────────── Cloudflare Worker: attribution-pipeline ────────────────────────────────────┐
│  HTTP  /hooks/call-platform   /hooks/ai-screening   /hooks/dni      (verify secret → store raw → 200 fast)       │
│  CRON  process-events (5m) · crm-poll (15m) · capi-dispatch (5m) · daily-feed (06:00 ET) · watchdog (hourly)     │
└───────────────┬───────────────────────────────────────────────────────────────────────────────┬────────────────┘
                ▼                                                                               ▼
     Postgres (Supabase) via Hyperdrive                                         Outputs
     raw_events → calls / screenings / clicks → leads + stage_history          • Meta Conversions API (dry-run / test mode)
     outbox · job_runs · sync_state                                             • Daily outcome CSV (R2) + Slack summary
                                                                                • Slack alerts (watchdog)
```

**Key design choices:**
1. **Store raw events first, process later.** Webhooks only verify, store and return 200. Downstream bugs never lose data, and everything can be **replayed**.
2. **Raw events are the source of truth; leads are derived.** Processing is deterministic, so re-running or replaying gives the **same result** (safe to run twice).
3. **Outbox pattern for outbound calls.** Meta events are written to an `outbox` table in the same transaction as the lead change, then a dispatcher sends them with retries. Deterministic `event_id`s mean Meta also drops duplicates.
4. **Every scheduled run is recorded** in `job_runs` with status `success | partial | failed` and counts. "Partial" is never reported as success.
5. **A watchdog checks the other jobs** (a "dead man's switch"): if a job hasn't succeeded within its expected interval, or backlogs grow, it sends an alert.

## 3. Data model (Postgres)

| Table | Purpose | Idempotency key |
|---|---|---|
| `raw_events` | Every inbound webhook or polled record, as received (jsonb), plus `processed_at` / `error` | `UNIQUE(source, source_event_id)` |
| `dni_sessions` | Visitor session → tracking number + `fbc`, `fbp`, campaign/adset/ad ids, assigned time | `session_id` |
| `calls` | One row per call: tracking number, caller (E.164), times, duration, buyer, `billable`, payout, `duplicate_of` | `call_id` |
| `screenings` | AI pre-qualification: qualified, intent, summary, ended reason | `screening_id` |
| `leads` | **One record per lead (caller phone within 30 days)** with attribution and current stage | `lead_id` (deterministic from phone + first call) |
| `lead_stage_history` | called → qualified → appointment → sold / lost, with source and time | `UNIQUE(lead_id, stage)` |
| `outbox` | Outbound Meta events: payload, status, attempts, `next_attempt_at`, last error, response | `event_id = sha256(lead_id:stage)` |
| `sync_state` | Polling cursors (e.g. CRM `updated_since`), advanced only after a page is committed | `source` |
| `job_runs` | Run ledger: job, trigger, start/end, status, counts, error | `run_id` |

**Attribution rule:** a call is matched to the DNI session that held the dialed tracking number at call time, within a time window. If there's no match, it falls back to campaign-level attribution, and the lead records an `attribution_confidence` of `click | campaign | none`. Unknown stays unknown.

**Billing rule:** billable if connected for at least 90 seconds **and** the caller isn't a repeat within 30 days. Repeat callers are linked through `duplicate_of`.

## 4. Jobs
Each job gets a **plain-English description** in `docs/jobs/<job>.md` (what it does, where, step by step, how it fails, how to re-run). A test checks every registered job has one.

| Job | Trigger | What it does | Safe to run twice because… | Failure modes handled |
|---|---|---|---|---|
| **ingest** | HTTP webhooks | Check shared secret/signature → validate shape (Zod) → insert into `raw_events` with `ON CONFLICT DO NOTHING` → 200 | Unique `(source, source_event_id)` | Bad signature → 401; invalid payload → stored with error and flagged, never silently dropped |
| **process-events** | cron 5m | Unprocessed raw events in time order → normalize (phone to E.164) → upsert calls, screenings, sessions → resolve lead → stage history → enqueue outbox | Upserts + unique stage history + deterministic ids | One bad event marks that event as failed and the run as `partial`; the rest continue. Out-of-order events are handled (a stage can arrive before its call). |
| **crm-poll** | cron 15m | OAuth client-credentials → page through `updated_since` → raw events → cursor advanced per committed page | Cursor only moves after commit; raw-event uniqueness | Token expiry → refresh and retry; 429 → respect `Retry-After`; 5xx → backoff, run `partial`; never skips records |
| **capi-dispatch** | cron 5m | Send pending outbox events to Meta in batches; **DRY_RUN** and `test_event_code` modes | Deterministic `event_id` (Meta deduplicates) + outbox status | Partial batch failures; exponential backoff; dead-letter after N attempts; events outside Meta's allowed time window are skipped with a reason |
| **daily-feed** | cron 06:00 ET | Yesterday by campaign/ad set/ad: calls, billable, qualified, appointments, sold, revenue, payout → CSV in R2 + Slack summary | Output is keyed by date (overwrite, never append) | Re-run for any date: `/admin/rerun?job=daily-feed&date=…` |
| **watchdog** | cron hourly | Each job's last success vs expected interval; stuck runs; raw-event and outbox backlogs; dead letters → Slack alert (de-duplicated) | Read-only + alert de-duplication | Watches itself: if it can't run, the daily Slack summary goes missing, and that's visible |

*Cloudflare free-plan constraint: 5 cron triggers per account. `process-events` and `capi-dispatch` share one 5-minute trigger, so 4 triggers are used.*

## 5. Simulator
A separate Worker or script that produces **realistic messy traffic**, plus a **mock CRM API**:
- **Volume:** N clicks/day → ~X% call → some get AI screening → buyer connect → CRM outcomes **1–10 days later**.
- **Chaos knobs:**
  - duplicate webhooks (10%), out-of-order delivery
  - phone formats (`(512) 555-0134`, `+1 512…`, `5125550134`)
  - repeat callers, missing DNI sessions
  - CRM 5xx and 429 responses, token expiry every 5 min, slow pages
- **Fast-forward:** simulates 30 days of traffic in minutes (time is a parameter), so a month of results can be reproduced on demand.
- **Ground truth:** the simulator knows the true attribution and outcomes, so a test can assert the pipeline's totals **match ground truth exactly**, even under chaos. *This is the headline proof.*

## 6. Tech stack
| Part | Choice | Why |
|---|---|---|
| Runtime | **Cloudflare Workers, TypeScript** | Free tier; cron + HTTP in one place; edge-fast webhooks |
| Router / validation | Hono · Zod | Light, Workers-native |
| DB | **Postgres** (Supabase in production) via **Hyperdrive** | Real SQL: transactions, upserts, `SKIP LOCKED`, `jsonb`; portable to any Postgres |
| SQL | `postgres` (porsager) with plain SQL + migration files | Idempotency logic stays visible in SQL, not hidden in an ORM |
| Storage / alerts | R2 (CSV) · Slack incoming webhook | Free; standard tooling for US teams |
| Tests / CI | Vitest (unit + integration against a Postgres container) · GitHub Actions | Every change is proven before it ships |
| Local dev | `wrangler dev` + local Postgres in Docker | Works offline on the laptop |

## 7. Testing strategy
- **Unit:** phone normalization, attribution matching, billing rule, repeat-caller detection, `event_id` determinism, Meta payload shape (hashed `ph`, `fbc`, `action_source`).
- **Idempotency:** process the same event set **twice** → identical database state (compare table snapshots).
- **Order-independence:** process **shuffled** events → same final state (property test).
- **Chaos end-to-end:** simulator with 20% errors + duplicates → after N cycles, pipeline totals = simulator ground truth.
- **Watchdog:** freeze a job → alert fires once (de-duplicated) → recovery message.
- **CI:** typecheck, lint, tests on every PR; badge in the README.

## 8. Repository layout
```
lead-attribution-pipeline/
  src/          worker entry, routes, jobs/, domain/ (normalize, attribute, bill), db/, meta/, alerts/
  simulator/    traffic generator + mock CRM API + ground truth
  migrations/   SQL
  docs/         ARCHITECTURE.md (diagram), jobs/*.md (plain-English job descriptions), RUNBOOK.md
  test/         unit, integration, chaos
  .github/workflows/ci.yml
```

## Out of scope (v1)
Real ad spend import (use simulated spend), the media-buying agent (a natural "phase 2" to mention in proposals), UI beyond a minimal `/admin` status page, multi-tenant setup.
