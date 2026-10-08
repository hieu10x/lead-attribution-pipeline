# Job: ingest (webhook receiver)

## What it does
This is the worker to store events from the sources such as call platform, ai screening and DNI. The events will be processed later.

## Where it runs / how it's triggered
It is designed to run on the Cloudflare Workers. Which is very economical and scalable. The worker exposes the webhooks corresponding to the sources. The sources query the webhook URLs when they need to notify us of new events. The webhooks are protected by a secret.

## Step by step
1. A source sends an event to its webhook URL.
2. If the query successfully authenticated, processing continues.
3. The worker detect the source type by the query's path.
4. It saves the events exactly as received, labelled with the source's own event ID. If that event was already sent, nothing happens, so a resent event is never counted twice.

## How it can fail, and what happens then

| What goes wrong | What the system does | Is data lost? |
| --------------- | -------------------- | ------------- |
| Wrong or missing secret | Rejects it (401) and saves nothing | No, it wasn't a trusted sender |
| Unknown address (misconfigured sender) | Rejects it (404) | The sender see the error and can fix the URL |
| Event larger than 256 KB | Rejects it (413) and saves nothing | Only abnormal payloads |
| Data in an unexpected format | Accepts it and saves it flagged with a reason | No, it's kept for inspection and can be reprocessed when the format is supported |
| Our database is unavailable | Ask the sender to retry later (503) | No, sender retry automatically |


## How to check it's working
A simple test can be done to test if the setup is successful.
In a terminal, run the command to simulate an event arrival 
```
curl -s -X POST localhost:8787/hooks/call-platform \
 -H 'x-webhook-secret: dev-secret-change-me' -H 'content-type: application/json' \
 -d '{"event":"completed","callId":"CA1","trackingNumber":"+15125550100","callerNumber":"5125550134","timestamp":"2026-10-07T14:03:00Z","durationSec":95}
```

Then check if it was stored properly with the command:
```
docker compose exec postgres psql -U lap -c "select id, source, source_event_id, event_type, payload, process_error from raw_events"
```

## How to re-run or recover
- Senders retry automatically on a 503.
- Flagged events are kept and can be reprocessed once the schema is fixed (replay arrives in M3).
- Duplicates from retries are harmless.
