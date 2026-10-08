# lead-attribution-pipeline

[![CI](https://github.com/hieu10x/lead-attribution-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/hieu10x/lead-attribution-pipeline/actions/workflows/ci.yml)

**Which ads produce sold jobs, not just phone calls?**

A pay-per-call lead-generation business has its data spread across ad clicks, a call-routing platform, an AI call screener and its buyers' CRMs, and its automations fail silently. This project joins those sources into **one record per lead**, follows each lead from **click → call → qualified → appointment → sold**, and feeds the outcomes back to Meta's Conversions API, so ad spend is optimized for revenue.

It's built to be **reliable by design**:
- **Store first, process later.** Webhooks only verify and store raw events, so nothing is lost and everything is replayable.
- **Safe to run twice.** Idempotency keys, deterministic ids, and derived tables you can rebuild from raw events.
- **Outbox for side effects.** Ad-platform events are queued in the same transaction as the lead change, then sent with retries and dedup ids.
- **Honest run ledger.** Every job run is recorded as `success`, `partial` or `failed`, never "success" when part of the work failed.
- **Watchdog.** Alerts when a job silently stops or a backlog grows.
- **Proven, not claimed.** A chaos simulator (duplicates, out-of-order events, API errors, rate limits, expired tokens) plus tests that pipeline totals equal ground truth.

All data is **synthetic**: a fictional home-services pay-per-call company, "RoofCall".

→ Architecture and design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Stack
Cloudflare Workers (TypeScript, Hono, Zod) · Postgres via Hyperdrive · Vitest · GitHub Actions

## Status
- [x] **M0** Skeleton: Worker, local Postgres, migrations, tests, CI
- [x] **M1** Webhook ingestion with idempotency ([how it works](docs/jobs/ingest.md))
- [ ] **M2** Simulator + mock CRM API with chaos
- [ ] **M3** Event processing: normalize, attribute, bill, leads
- [ ] **M4** CRM polling (OAuth, pagination, rate limits)
- [ ] **M5** Meta CAPI outbox (dry-run / test mode) + daily outcome feed
- [ ] **M6** Watchdog, job docs, runbook, chaos end-to-end test
- [ ] **M7** Deploy (Cloudflare + Supabase)

## Run locally
Requires Node 24, pnpm and Docker.
```bash
pnpm install
pnpm db:up          # local Postgres on 127.0.0.1:54329
pnpm db:migrate
pnpm test           # unit + integration
pnpm dev            # Worker on http://localhost:8787 → /health, /health/db
```

## License
MIT
