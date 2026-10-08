# Job: ingest (webhook receiver)

## What it does
Receives events from our data sources (the call platform, the AI call screener, and the website's number-tracking script, "DNI") and saves them safely. Nothing is calculated at this stage; the events are processed later by a separate job.

## Where it runs / how it's triggered
It runs on Cloudflare Workers (Cloudflare's global network, with no server for us to maintain). Each source has its own **webhook**: a private web address the source calls whenever something happens, such as a call ending. Every request must include a shared secret, so only our sources can send data.

## Step by step
1. A source sends an event to its webhook address.
2. The receiver checks the shared secret. Without the right secret, the request is rejected.
3. It identifies the source from the address used.
4. It saves the event **exactly as received**, labelled with the source's own event ID. If that event was already saved, nothing happens, so a resent event is never counted twice.

## How it can fail, and what happens then

| What goes wrong | What the system does | Is data lost? |
| --- | --- | --- |
| Wrong or missing secret | Rejects it (401) and saves nothing | No. It wasn't a trusted sender. |
| Unknown address (misconfigured sender) | Rejects it (404) | No. The sender sees the error and can fix the address. |
| Event larger than 256 KB | Rejects it (413) and saves nothing | Only abnormal payloads are refused. |
| Data in an unexpected format | Accepts it and saves it **flagged**, with the reason | No. It's kept for inspection and can be reprocessed once the format is supported. |
| Our database is unavailable | Asks the sender to retry later (503) | No. Senders retry automatically. |

## How to re-run or recover
- **Safe to receive twice:** a repeated event is recognized and ignored, so retries never cause double counting.
- **Database outages:** senders retry automatically after a 503; no action needed.
- **Flagged events:** kept with their original content and error. Once the format is supported, they can be reprocessed (replay tooling is planned).

## For developers: local check
With `pnpm dev` running, simulate an event:
```bash
curl -s -X POST localhost:8787/hooks/call-platform \
  -H 'x-webhook-secret: dev-secret-change-me' -H 'content-type: application/json' \
  -d '{"event":"completed","callId":"CA1","trackingNumber":"+15125550100","callerNumber":"5125550134","timestamp":"2026-10-07T14:03:00Z","durationSec":95}'
```
Expected: `{"status":"stored","valid":true}`; sending it again returns `"duplicate"`.

Inspect what was stored:
```bash
docker compose exec postgres psql -U lap -c "select id, source, source_event_id, event_type, process_error from raw_events"
```
