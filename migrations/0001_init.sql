-- 0001: raw event store + job run ledger (foundation for idempotent, replayable processing)

-- Every inbound webhook / polled record, stored exactly as received.
-- (source, source_event_id) makes ingestion idempotent: duplicates are ignored, never double-processed.
create table raw_events (
  id              bigint generated always as identity primary key,
  source          text        not null,               -- e.g. 'call_platform', 'ai_screening', 'dni', 'crm'
  source_event_id text        not null,               -- the sender's unique id for this event
  event_type      text        not null,               -- e.g. 'call.completed', 'screening.report', 'lead.updated'
  occurred_at     timestamptz,                        -- when it happened at the source (may be missing/late)
  received_at     timestamptz not null default now(),
  payload         jsonb       not null,
  processed_at    timestamptz,                        -- null = not yet processed
  process_error   text,                               -- last processing error (event is retried / flagged)
  attempts        integer     not null default 0,
  unique (source, source_event_id)
);

create index raw_events_unprocessed_idx on raw_events (received_at) where processed_at is null;

-- One row per job run. 'partial' exists so a run that skipped failures is never reported as success.
create table job_runs (
  run_id      uuid        primary key default gen_random_uuid(),
  job_name    text        not null,
  trigger     text        not null check (trigger in ('cron', 'manual', 'test')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text        not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  counts      jsonb       not null default '{}'::jsonb,
  error       text
);

create index job_runs_job_started_idx on job_runs (job_name, started_at desc);
