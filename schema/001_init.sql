CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    ingest_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    event_type TEXT NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    domain TEXT,
    entity_id TEXT,
    service TEXT,
    context_id TEXT,
    parent_context_id TEXT,
    user_id TEXT,
    source TEXT NOT NULL DEFAULT 'home_assistant',
    dedupe_key TEXT,
    collector_instance TEXT NOT NULL DEFAULT 'unknown',
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_event_time ON events (event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_domain ON events (domain);
CREATE INDEX IF NOT EXISTS idx_events_entity_id ON events (entity_id);
CREATE INDEX IF NOT EXISTS idx_events_context_id ON events (context_id);
CREATE INDEX IF NOT EXISTS idx_events_data_gin ON events USING GIN (data);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_key_unique
    ON events (dedupe_key);
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

CREATE TABLE IF NOT EXISTS entity_snapshots (
    id BIGSERIAL PRIMARY KEY,
    entity_id TEXT NOT NULL,
    state TEXT,
    domain TEXT,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    context_id TEXT,
    captured_at TIMESTAMPTZ NOT NULL,
    source_event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_snapshots_entity_time
    ON entity_snapshots (entity_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS automation_snapshots (
    id BIGSERIAL PRIMARY KEY,
    automation_id TEXT NOT NULL,
    alias TEXT,
    is_enabled BOOLEAN,
    trigger_config JSONB NOT NULL DEFAULT '[]'::jsonb,
    action_config JSONB NOT NULL DEFAULT '[]'::jsonb,
    conditions_config JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL,
    source_event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_snapshots_auto_time
    ON automation_snapshots (automation_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS trace_contexts (
    id BIGSERIAL PRIMARY KEY,
    context_id TEXT NOT NULL UNIQUE,
    root_context_id TEXT,
    related_context_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id BIGSERIAL PRIMARY KEY,
    run_uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
    run_type TEXT NOT NULL,
    status TEXT NOT NULL,
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS insights (
    id BIGSERIAL PRIMARY KEY,
    agent_run_id BIGINT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    rank INT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    root_cause TEXT,
    confidence NUMERIC(5,4),
    severity NUMERIC(5,4),
    recommendation JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_agent_run_id ON insights (agent_run_id);

CREATE TABLE IF NOT EXISTS evidence (
    id BIGSERIAL PRIMARY KEY,
    evidence_uuid UUID NOT NULL DEFAULT uuid_generate_v4(),
    insight_id BIGINT REFERENCES insights(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
    entity_id TEXT,
    context_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_insight_id ON evidence (insight_id);
CREATE INDEX IF NOT EXISTS idx_evidence_event_id ON evidence (event_id);

CREATE TABLE IF NOT EXISTS analysis_results (
    id BIGSERIAL PRIMARY KEY,
    agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE CASCADE,
    report_markdown TEXT NOT NULL,
    report_json JSONB NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendations (
    id BIGSERIAL PRIMARY KEY,
    agent_run_id BIGINT REFERENCES agent_runs(id) ON DELETE CASCADE,
    insight_id BIGINT REFERENCES insights(id) ON DELETE SET NULL,
    recommendation_type TEXT NOT NULL,
    target_automation_id TEXT,
    change_payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
