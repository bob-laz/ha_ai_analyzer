ALTER TABLE events
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
    ADD COLUMN IF NOT EXISTS collector_instance TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_key_unique
    ON events (dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_context_time
    ON events (context_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_parent_context_id
    ON events (parent_context_id);

CREATE INDEX IF NOT EXISTS idx_events_entity_time
    ON events (entity_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_service_time
    ON events (service, event_time DESC)
    WHERE service IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_collector_received
    ON events (collector_instance, received_at DESC);
