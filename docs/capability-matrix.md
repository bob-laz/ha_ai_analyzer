# Tool Capability Matrix

| Function                                            | Status      | Source                    | Notes                                                            |
| --------------------------------------------------- | ----------- | ------------------------- | ---------------------------------------------------------------- |
| `getDailySummary` / `get_daily_summary`             | Implemented | `tools/src/agentTools.ts` | Timezone-aware day window aggregation over `events`.             |
| `getTopChanges` / `get_top_changes`                 | Implemented | `tools/src/agentTools.ts` | Compares current window vs prior window of equal length.         |
| `traceContext` / `trace_context`                    | Implemented | `tools/src/agentTools.ts` | Recursive context graph + related events + trace metadata.       |
| `publishReport` / `publish_report`                  | Implemented | `tools/src/agentTools.ts` | Persists to `analysis_results` when DB provided; stub otherwise. |
| `entityTimeline` / `entity_timeline`                | Implemented | `tools/src/agentTools.ts` | Bucketed event counts for a target entity and window.            |
| `correlate`                                         | Implemented | `tools/src/agentTools.ts` | Context-overlap correlation ranking for related entities/services. |
| `getAutomationSnapshot` / `get_automation_snapshot` | Implemented | `tools/src/agentTools.ts` | Latest automation snapshot + recent event activity summary.      |
| `listAutomations` / `list_automations`              | Implemented | `tools/src/agentTools.ts` | Latest snapshots with search/enabled/limit/offset filtering.     |

## Agent Guidance

- Prefer DB-backed execution for tool calls; without a DB client functions return typed stubs.
- Keep function output contracts stable across refactors.
