# Data Contracts

## Core Tables

### `events`
Required fields used by ingestion and tools:
- `event_type` `text`
- `event_time` `timestamptz`
- `domain` `text | null`
- `entity_id` `text | null`
- `service` `text | null`
- `context_id` `text | null`
- `parent_context_id` `text | null`
- `user_id` `text | null`
- `data` `jsonb`
- `dedupe_key` `text | null` (unique when present)
- `collector_instance` `text`
- `received_at` `timestamptz`

### `trace_contexts`
- `context_id` `text` (unique)
- `root_context_id` `text | null`
- `related_context_ids` `jsonb` array
- `metadata` `jsonb`

### `analysis_results`
- `agent_run_id` `bigint | null`
- `report_markdown` `text`
- `report_json` `jsonb`
- `published_at` `timestamptz`

## Tool Return Shapes

### `getDailySummary(date, db, timezone)`
```ts
{
  day: string;
  timezone: string;
  totalEvents: number;
  uniqueEntities: number;
  stateChanges: number;
  serviceCalls: number;
}
```

### `getTopChanges(window, limit, db)`
```ts
{
  window: { start: string; end: string };
  limit: number;
  rows: Array<{
    subjectType: 'entity' | 'service';
    subjectId: string;
    currentCount: number;
    previousCount: number;
    delta: number;
  }>;
}
```

### `traceContext(contextId, db, maxDepth)`
```ts
{
  requestedContextId: string;
  rootContextId: string | null;
  contextDepth: Array<{ contextId: string; depth: number }>;
  relatedContextMetadata: Array<{
    contextId: string;
    rootContextId: string | null;
    relatedContextIds: string[];
    metadata: Record<string, unknown>;
  }>;
  events: Array<{
    id: number;
    eventTime: string;
    eventType: string;
    domain: string | null;
    entityId: string | null;
    service: string | null;
    contextId: string | null;
    parentContextId: string | null;
    userId: string | null;
    data: Record<string, unknown>;
  }>;
}
```

### `publishReport(markdown, jsonPayload, db, agentRunId)`
```ts
{
  status: 'published' | 'stub';
  analysisResultId?: number;
  publishedAt?: string;
  markdownPreview: string;
  payloadKeys: string[];
}
```

## Stub Contract
Unimplemented tools return:
```ts
{
  status: 'stub';
  function: string;
  todo: string;
}
```
