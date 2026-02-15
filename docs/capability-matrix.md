# Tool Capability Matrix

| Function                                            | Status      | Source                    | Notes                                                            |
| --------------------------------------------------- | ----------- | ------------------------- | ---------------------------------------------------------------- |
| `getDailySummary` / `get_daily_summary`             | Implemented | `tools/src/agentTools.ts` | Timezone-aware day window aggregation over `events`.             |
| `getTopChanges` / `get_top_changes`                 | Implemented | `tools/src/agentTools.ts` | Compares current window vs prior window of equal length.         |
| `traceContext` / `trace_context`                    | Implemented | `tools/src/agentTools.ts` | Recursive context graph + related events + trace metadata.       |
| `publishReport` / `publish_report`                  | Implemented | `tools/src/agentTools.ts` | Persists to `analysis_results` when DB provided; stub otherwise. |
| `entityTimeline` / `entity_timeline`                | Stub        | `tools/src/interfaces.ts` | Returns typed stub with implementation TODO.                     |
| `correlate`                                         | Stub        | `tools/src/interfaces.ts` | Returns typed stub with implementation TODO.                     |
| `getAutomationSnapshot` / `get_automation_snapshot` | Stub        | `tools/src/interfaces.ts` | Returns typed stub with implementation TODO.                     |
| `listAutomations` / `list_automations`              | Stub        | `tools/src/interfaces.ts` | Returns typed stub with implementation TODO.                     |

## Agent Guidance

- Prefer implemented functions for production analysis paths.
- Treat stub responses as non-fatal and continue workflow with explicit limitation reporting.
- Do not infer behavior for stubbed functions beyond the `todo` contract.
