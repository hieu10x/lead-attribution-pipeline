# Job descriptions

Every job has a plain-English description here: **what it does, where, step by step, how it can fail, and how to re-run it safely.**
A test (added in M6) checks that every registered job has a description, so docs can't silently drift from code.

| Job | Trigger | Status |
|---|---|---|
| ingest | HTTP webhooks | planned (M1) |
| process-events | cron, 5 min | planned (M3) |
| crm-poll | cron, 15 min | planned (M4) |
| capi-dispatch | cron, 5 min | planned (M5) |
| daily-feed | cron, 06:00 ET | planned (M5) |
| watchdog | cron, hourly | planned (M6) |
