import { type FormEvent, type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';

import type {
  ActionOperation,
  EnvironmentSnapshotType,
  OperationKind,
  RecentEventRow,
  RecommendationRow,
  RecommendationStatus,
  ResourceUsageReading,
} from '../shared/types.js';
import {
  clearApiCredentials,
  fetchAction,
  fetchCurrentAutomationSnapshots,
  fetchCurrentEntitySnapshots,
  fetchCurrentEnvironmentSnapshots,
  fetchHealth,
  fetchLatestReport,
  fetchOverview,
  fetchRecentAnomalies,
  fetchRecentEvents,
  fetchRecommendations,
  fetchResourceUsage,
  fetchRuns,
  hasApiCredentials,
  runAction,
  saveApiCredentials,
  updateRecommendationStatus,
} from './api.js';

type AppProps = {
  defaultPollIntervalMs: number;
};

type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'danger' | 'neutral';
  onConfirm: () => Promise<void> | void;
};

type HealthCardProps = {
  title: string;
  value: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  subValue?: string;
};

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/runs', label: 'Runs' },
  { to: '/recommendations', label: 'Recommendations' },
  { to: '/reports', label: 'Reports' },
  { to: '/events', label: 'Events' },
  { to: '/snapshots', label: 'Snapshots' },
  { to: '/usage', label: 'Usage' },
] as const;

const ACTION_BUTTONS: Array<{ kind: OperationKind; label: string; description: string }> = [
  {
    kind: 'run-analysis',
    label: 'Run Analysis',
    description: 'Execute one LLM analysis pass now.',
  },
  {
    kind: 'run-daily-summary',
    label: 'Run Daily Summary',
    description: 'Generate one daily summary/anomaly report now.',
  },
  {
    kind: 'run-automation-snapshots',
    label: 'Run Snapshot Sync',
    description: 'Capture automations, environment inventory, and usage snapshots.',
  },
  {
    kind: 'run-retention',
    label: 'Run Retention',
    description: 'Apply partition upkeep and retention pruning now.',
  },
];

const formatDateTime = (value: string | null): string => {
  if (!value) {
    return 'n/a';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
};

const formatNumber = (value: number): string => {
  return new Intl.NumberFormat().format(value);
};

const formatDuration = (start: string, end: string | null): string => {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return 'n/a';
  }

  const seconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return `${minutes}m ${remSeconds}s`;
};

const statusClass = (status: string): string => {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'accepted') {
    return 'status-chip status-chip--good';
  }
  if (normalized === 'failed' || normalized === 'rejected') {
    return 'status-chip status-chip--bad';
  }
  if (normalized === 'running' || normalized === 'queued') {
    return 'status-chip status-chip--warn';
  }
  return 'status-chip';
};

const usePollingState = <T,>(
  loader: () => Promise<T>,
  pollIntervalMs: number,
): AsyncState<T> & { refresh: () => Promise<void> } => {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const data = await loader();
      setState({ data, loading: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({ ...current, loading: false, error: message }));
    }
  }, [loader]);

  useEffect(() => {
    let active = true;

    const run = async (): Promise<void> => {
      try {
        const data = await loader();
        if (!active) {
          return;
        }
        setState({ data, loading: false, error: null });
      } catch (error) {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, loading: false, error: message }));
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, pollIntervalMs);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [loader, pollIntervalMs]);

  return { ...state, refresh };
};

const HealthCard = ({ title, value, subValue, tone = 'default' }: HealthCardProps): ReactElement => {
  return (
    <article className={`health-card health-card--${tone}`}>
      <p className="health-card__title">{title}</p>
      <p className="health-card__value">{value}</p>
      {subValue ? <p className="health-card__subvalue">{subValue}</p> : null}
    </article>
  );
};

const ConfirmModal = ({ state, onClose }: { state: ConfirmState; onClose: () => void }): ReactElement => {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    try {
      setSubmitting(true);
      await state.onConfirm();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={state.title}>
        <h3>{state.title}</h3>
        <p>{state.description}</p>
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${state.variant === 'danger' ? 'button--danger' : 'button--primary'}`}
            onClick={() => {
              void handleConfirm();
            }}
            disabled={submitting}
          >
            {submitting ? 'Working...' : state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const LoginGate = ({ onAuthenticated }: { onAuthenticated: () => void }): ReactElement => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      saveApiCredentials(username, password);
      await fetchHealth();
      onAuthenticated();
    } catch (submitError) {
      clearApiCredentials();
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-card">
        <p className="eyebrow">HA AI Operator Console</p>
        <h1>Authenticate</h1>
        <p>Use the basic-auth credentials configured in your environment.</p>
        <form onSubmit={(event) => void handleSubmit(event)} className="login-form">
          <label>
            Username
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <input
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
              type="password"
              required
            />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="button button--primary" disabled={submitting}>
            {submitting ? 'Authenticating...' : 'Enter Console'}
          </button>
        </form>
      </section>
    </main>
  );
};

const DashboardPage = ({
  pollIntervalMs,
  onTriggerAction,
  operations,
}: {
  pollIntervalMs: number;
  onTriggerAction: (kind: OperationKind, label: string) => void;
  operations: ActionOperation[];
}): ReactElement => {
  const loadRecentAnomalies = useCallback(() => fetchRecentAnomalies(6), []);
  const overview = usePollingState(fetchOverview, pollIntervalMs);
  const health = usePollingState(fetchHealth, pollIntervalMs);
  const anomalies = usePollingState(loadRecentAnomalies, pollIntervalMs);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Operational Dashboard</h2>
          <p>Live status for collector throughput, analysis pipelines, and triage queues.</p>
        </div>
      </header>

      {overview.error || health.error ? <p className="error-text">{overview.error || health.error}</p> : null}

      <div className="health-grid">
        <HealthCard
          title="Collector Last Event"
          value={formatDateTime(overview.data?.latestCollectorEventAt ?? null)}
          tone={overview.data?.latestCollectorEventAt ? 'good' : 'warn'}
        />
        <HealthCard
          title="Events (Last 5m)"
          value={formatNumber(overview.data?.ingestion.events5m ?? 0)}
          subValue={`1h: ${formatNumber(overview.data?.ingestion.events1h ?? 0)} • 24h: ${formatNumber(overview.data?.ingestion.events24h ?? 0)}`}
        />
        <HealthCard
          title="Proposed Recommendations"
          value={formatNumber(overview.data?.recommendationCounts.proposed ?? 0)}
          subValue={`Accepted: ${formatNumber(overview.data?.recommendationCounts.accepted ?? 0)} • Rejected: ${formatNumber(
            overview.data?.recommendationCounts.rejected ?? 0,
          )}`}
        />
        <HealthCard
          title="Daily Summary Anomalies"
          value={formatNumber(overview.data?.latestDailySummary.anomalyCount ?? 0)}
          subValue={
            overview.data?.latestDailySummary.publishedAt
              ? `Published ${formatDateTime(overview.data.latestDailySummary.publishedAt)}`
              : 'No daily summary found'
          }
          tone={(overview.data?.latestDailySummary.anomalyCount ?? 0) > 0 ? 'warn' : 'good'}
        />
        <HealthCard
          title="API + DB Health"
          value={health.data?.ok ? 'Healthy' : 'Degraded'}
          subValue={health.data?.dbTime ? `DB time: ${formatDateTime(health.data.dbTime)}` : 'No DB timestamp'}
          tone={health.data?.ok ? 'good' : 'bad'}
        />
      </div>

      <section className="panel">
        <header className="panel__header">
          <h3>Quick Actions</h3>
          <p>Manual job controls (all actions require confirmation).</p>
        </header>
        <div className="actions-grid">
          {ACTION_BUTTONS.map((action) => {
            return (
              <button
                key={action.kind}
                type="button"
                className="action-button"
                onClick={() => {
                  onTriggerAction(action.kind, action.label);
                }}
              >
                <span>{action.label}</span>
                <small>{action.description}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h3>Recent Operations</h3>
          <p>Manual action execution status (ephemeral in-memory store).</p>
        </header>
        {operations.length === 0 ? <p className="empty-state">No manual operations yet.</p> : null}
        <ul className="operation-list">
          {operations.slice(0, 8).map((operation) => {
            return (
              <li key={operation.id} className="operation-list__item">
                <div>
                  <p className="mono">{operation.kind}</p>
                  <p>{operation.message || 'No message'}</p>
                </div>
                <div className="operation-list__meta">
                  <span className={statusClass(operation.status)}>{operation.status}</span>
                  <small>{formatDateTime(operation.updatedAt)}</small>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h3>Recent Anomalies</h3>
          <p>Latest anomaly entries parsed from daily summary reports.</p>
        </header>
        {anomalies.error ? <p className="error-text">{anomalies.error}</p> : null}
        {(anomalies.data?.anomalies ?? []).length === 0 ? <p className="empty-state">No recent anomalies.</p> : null}
        <ul className="operation-list">
          {(anomalies.data?.anomalies ?? []).map((anomaly) => {
            return (
              <li
                key={`${anomaly.analysisResultId}-${anomaly.metric}-${anomaly.publishedAt}`}
                className="operation-list__item"
              >
                <div>
                  <p className="mono">{anomaly.metric}</p>
                  <p>
                    value {anomaly.value.toFixed(2)} vs baseline {anomaly.baselineMean.toFixed(2)} (delta{' '}
                    {anomaly.delta.toFixed(2)})
                  </p>
                </div>
                <div className="operation-list__meta">
                  <span className={statusClass('running')}>
                    z={anomaly.zScore === null ? 'n/a' : anomaly.zScore.toFixed(2)}
                  </span>
                  <small>{formatDateTime(anomaly.publishedAt)}</small>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
};

const RunsPage = ({ pollIntervalMs }: { pollIntervalMs: number }): ReactElement => {
  const [runType, setRunType] = useState('');
  const [status, setStatus] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);

  const loader = useCallback(
    () => fetchRuns({ limit: 80, runType: runType || undefined, status: status || undefined }),
    [runType, status],
  );
  const runs = usePollingState(loader, pollIntervalMs);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Agent Runs</h2>
          <p>Filter and inspect scheduler/manual run metadata.</p>
        </div>
      </header>

      <section className="panel">
        <div className="toolbar">
          <label>
            Run Type
            <input
              value={runType}
              placeholder="llm_analysis"
              onChange={(event) => {
                setRunType(event.target.value);
              }}
            />
          </label>
          <label>
            Status
            <input
              value={status}
              placeholder="completed"
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void runs.refresh();
            }}
          >
            Refresh
          </button>
        </div>

        {runs.error ? <p className="error-text">{runs.error}</p> : null}
        {runs.loading && !runs.data ? <p className="muted">Loading runs...</p> : null}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Started</th>
                <th>Completed</th>
                <th>Duration</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data?.runs ?? []).map((run) => {
                const expanded = expandedRunId === run.id;
                return (
                  <tr key={run.id}>
                    <td>{run.id}</td>
                    <td className="mono">{run.runType}</td>
                    <td>
                      <span className={statusClass(run.status)}>{run.status}</span>
                    </td>
                    <td>{formatDateTime(run.startedAt)}</td>
                    <td>{formatDateTime(run.completedAt)}</td>
                    <td>{formatDuration(run.startedAt, run.completedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--tiny"
                        onClick={() => {
                          setExpandedRunId(expanded ? null : run.id);
                        }}
                      >
                        {expanded ? 'Hide' : 'Show'}
                      </button>
                      {expanded ? <pre className="json-preview">{JSON.stringify(run.config, null, 2)}</pre> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
};

const RecommendationsPage = ({
  pollIntervalMs,
  showConfirm,
}: {
  pollIntervalMs: number;
  showConfirm: (state: ConfirmState) => void;
}): ReactElement => {
  const [statusFilter, setStatusFilter] = useState<'all' | RecommendationStatus>('all');
  const [rows, setRows] = useState<RecommendationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchRecommendations({
        limit: 200,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setRows(response.recommendations);
      setError(null);
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    let active = true;

    const run = async (): Promise<void> => {
      try {
        const response = await fetchRecommendations({
          limit: 200,
          status: statusFilter === 'all' ? undefined : statusFilter,
        });
        if (!active) {
          return;
        }
        setRows(response.recommendations);
        setError(null);
      } catch (refreshError) {
        if (!active) {
          return;
        }
        const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
        setError(message);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, pollIntervalMs);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pollIntervalMs, statusFilter]);

  const handleDecision = (row: RecommendationRow, nextStatus: 'accepted' | 'rejected'): void => {
    const action = nextStatus === 'accepted' ? 'Accept' : 'Reject';
    showConfirm({
      title: `${action} recommendation #${row.id}?`,
      description: `${action} will move this recommendation out of the proposed queue.`,
      confirmLabel: action,
      variant: nextStatus === 'rejected' ? 'danger' : 'neutral',
      onConfirm: async () => {
        setError(null);
        const previousRows = rows;
        setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: nextStatus } : item)));

        try {
          const updated = await updateRecommendationStatus(row.id, nextStatus);
          setRows((current) => current.map((item) => (item.id === row.id ? updated : item)));
        } catch (updateError) {
          setRows(previousRows);
          const message = updateError instanceof Error ? updateError.message : String(updateError);
          setError(message);
        }
      },
    });
  };

  const groupedRows = useMemo(() => {
    return {
      proposed: rows.filter((row) => row.status === 'proposed'),
      accepted: rows.filter((row) => row.status === 'accepted'),
      rejected: rows.filter((row) => row.status === 'rejected'),
    };
  }, [rows]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Recommendations</h2>
          <p>Triage model-proposed changes and mark accepted/rejected decisions.</p>
        </div>
      </header>

      <section className="panel">
        <div className="toolbar">
          <label>
            Filter
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as 'all' | RecommendationStatus);
              }}
            >
              <option value="all">All</option>
              <option value="proposed">Proposed</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void refresh();
            }}
          >
            Refresh
          </button>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        {loading && rows.length === 0 ? <p className="muted">Loading recommendations...</p> : null}

        <div className="triage-grid">
          {(['proposed', 'accepted', 'rejected'] as const).map((statusKey) => {
            const statusRows = groupedRows[statusKey];
            return (
              <article key={statusKey} className="triage-column">
                <header>
                  <h3>{statusKey.toUpperCase()}</h3>
                  <span>{statusRows.length}</span>
                </header>
                {statusRows.length === 0 ? <p className="empty-state">No items.</p> : null}
                {statusRows.map((row) => {
                  return (
                    <div key={row.id} className="recommendation-card">
                      <p className="mono">
                        #{row.id} • {row.recommendationType}
                      </p>
                      <p className="recommendation-card__title">{row.insightTitle || 'Untitled insight'}</p>
                      <p>{row.insightSummary || 'No summary provided.'}</p>
                      <pre className="json-preview">{JSON.stringify(row.changePayload, null, 2)}</pre>
                      <div className="recommendation-card__actions">
                        {row.status === 'proposed' ? (
                          <>
                            <button
                              type="button"
                              className="button button--tiny"
                              onClick={() => {
                                handleDecision(row, 'accepted');
                              }}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              className="button button--tiny button--danger"
                              onClick={() => {
                                handleDecision(row, 'rejected');
                              }}
                            >
                              Reject
                            </button>
                          </>
                        ) : (
                          <span className={statusClass(row.status)}>{row.status}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
};

const ReportsPage = ({ pollIntervalMs }: { pollIntervalMs: number }): ReactElement => {
  const [showRaw, setShowRaw] = useState(false);
  const [state, setState] = useState<
    AsyncState<{
      llm: Awaited<ReturnType<typeof fetchLatestReport>>;
      daily: Awaited<ReturnType<typeof fetchLatestReport>>;
    }>
  >({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let active = true;

    const run = async (): Promise<void> => {
      try {
        const [llm, daily] = await Promise.all([
          fetchLatestReport('llm_analysis'),
          fetchLatestReport('daily_home_summary'),
        ]);

        if (!active) {
          return;
        }

        setState({
          data: {
            llm,
            daily,
          },
          loading: false,
          error: null,
        });
      } catch (error) {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, loading: false, error: message }));
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, pollIntervalMs);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Latest Reports</h2>
          <p>Read the newest LLM analysis and daily summary artifacts.</p>
        </div>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setShowRaw((current) => !current);
          }}
        >
          {showRaw ? 'Show Markdown' : 'Show Raw JSON'}
        </button>
      </header>

      {state.error ? <p className="error-text">{state.error}</p> : null}
      {state.loading && !state.data ? <p className="muted">Loading reports...</p> : null}

      <div className="report-grid">
        {[
          { key: 'llm', label: 'LLM Analysis', report: state.data?.llm ?? null },
          { key: 'daily', label: 'Daily Home Summary', report: state.data?.daily ?? null },
        ].map((item) => {
          return (
            <article key={item.key} className="panel">
              <header className="panel__header">
                <h3>{item.label}</h3>
                <p>{item.report ? `Published ${formatDateTime(item.report.publishedAt)}` : 'No report available'}</p>
              </header>
              {item.report ? (
                showRaw ? (
                  <pre className="json-preview">{JSON.stringify(item.report.payload, null, 2)}</pre>
                ) : (
                  <pre className="markdown-preview">{item.report.markdown}</pre>
                )
              ) : (
                <p className="empty-state">No data yet.</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
};

const EventsPage = ({ pollIntervalMs }: { pollIntervalMs: number }): ReactElement => {
  const loadRecentEvents = useCallback(() => fetchRecentEvents(250), []);
  const eventsState = usePollingState(loadRecentEvents, pollIntervalMs);
  const [domainFilter, setDomainFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [contextFilter, setContextFilter] = useState('');
  const [selectedEvent, setSelectedEvent] = useState<RecentEventRow | null>(null);

  const filteredEvents = useMemo(() => {
    const rows = eventsState.data?.events ?? [];
    const domainQuery = domainFilter.trim().toLowerCase();
    const entityQuery = entityFilter.trim().toLowerCase();
    const serviceQuery = serviceFilter.trim().toLowerCase();
    const contextQuery = contextFilter.trim().toLowerCase();

    return rows.filter((row) => {
      const domainOk = !domainQuery || (row.domain ?? '').toLowerCase().includes(domainQuery);
      const entityOk = !entityQuery || (row.entityId ?? '').toLowerCase().includes(entityQuery);
      const serviceOk = !serviceQuery || (row.service ?? '').toLowerCase().includes(serviceQuery);
      const contextOk = !contextQuery || (row.contextId ?? '').toLowerCase().includes(contextQuery);
      return domainOk && entityOk && serviceOk && contextOk;
    });
  }, [contextFilter, domainFilter, entityFilter, eventsState.data?.events, serviceFilter]);

  useEffect(() => {
    if (!selectedEvent) {
      return;
    }

    const stillVisible = filteredEvents.some((row) => row.id === selectedEvent.id);
    if (!stillVisible) {
      setSelectedEvent(null);
    }
  }, [filteredEvents, selectedEvent]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Recent Events</h2>
          <p>Inspect normalized event fields and payload previews.</p>
        </div>
      </header>

      <section className="panel">
        <div className="toolbar toolbar--filters">
          <label>
            Domain
            <input value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} />
          </label>
          <label>
            Entity
            <input value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)} />
          </label>
          <label>
            Service
            <input value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)} />
          </label>
          <label>
            Context
            <input value={contextFilter} onChange={(event) => setContextFilter(event.target.value)} />
          </label>
        </div>

        {eventsState.error ? <p className="error-text">{eventsState.error}</p> : null}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Domain</th>
                <th>Entity</th>
                <th>Service</th>
                <th>Context</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No events match the current filters.
                  </td>
                </tr>
              ) : (
                filteredEvents.map((row) => {
                  return (
                    <tr
                      key={row.id}
                      className={selectedEvent?.id === row.id ? 'row-selected' : ''}
                      onClick={() => {
                        setSelectedEvent(row);
                      }}
                    >
                      <td>{formatDateTime(row.eventTime)}</td>
                      <td>{row.eventType}</td>
                      <td>{row.domain || '-'}</td>
                      <td className="mono">{row.entityId || '-'}</td>
                      <td>{row.service || '-'}</td>
                      <td className="mono">{row.contextId || '-'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {selectedEvent ? (
          <aside className="payload-drawer">
            <header>
              <h3>Payload Preview • Event #{selectedEvent.id}</h3>
              <button
                type="button"
                className="button button--tiny"
                onClick={() => {
                  setSelectedEvent(null);
                }}
              >
                Close
              </button>
            </header>
            <pre className="json-preview">{selectedEvent.payloadPreview}</pre>
          </aside>
        ) : null}
      </section>
    </section>
  );
};

const parseLimitInput = (value: string, fallback = 200): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(500, Math.floor(parsed));
};

const AutomationSnapshotsPane = ({
  pollIntervalMs,
  limit,
  search,
}: {
  pollIntervalMs: number;
  limit: number;
  search: string;
}): ReactElement => {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const loader = useCallback(() => {
    return fetchCurrentAutomationSnapshots({ limit, search: search || undefined });
  }, [limit, search]);
  const state = usePollingState(loader, pollIntervalMs);

  return (
    <section className="panel">
      <header className="panel__header">
        <h3>Automation Snapshots</h3>
        <p>
          Latest capture: {formatDateTime(state.data?.capturedAt ?? null)} · Showing {state.data?.snapshots.length ?? 0}
          {' / '}
          {formatNumber(state.data?.total ?? 0)}
        </p>
      </header>

      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          void state.refresh();
        }}
      >
        Refresh
      </button>

      {state.error ? <p className="error-text">{state.error}</p> : null}
      {state.loading && !state.data ? <p className="muted">Loading snapshots...</p> : null}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Automation</th>
              <th>Alias</th>
              <th>Enabled</th>
              <th>Captured</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {(state.data?.snapshots ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No automation snapshots found for the latest capture.
                </td>
              </tr>
            ) : (
              (state.data?.snapshots ?? []).map((row) => {
                const expanded = expandedId === row.id;
                return (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td className="mono">{row.automationId}</td>
                    <td>{row.alias || '-'}</td>
                    <td>{row.isEnabled === null ? 'unknown' : row.isEnabled ? 'enabled' : 'disabled'}</td>
                    <td>{formatDateTime(row.capturedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--tiny"
                        onClick={() => {
                          setExpandedId(expanded ? null : row.id);
                        }}
                      >
                        {expanded ? 'Hide' : 'Show'}
                      </button>
                      {expanded ? (
                        <pre className="json-preview">
                          {JSON.stringify(
                            {
                              triggerConfig: row.triggerConfig,
                              actionConfig: row.actionConfig,
                              conditionsConfig: row.conditionsConfig,
                              metadata: row.metadata,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const EnvironmentSnapshotsPane = ({
  pollIntervalMs,
  limit,
  search,
  snapshotType,
}: {
  pollIntervalMs: number;
  limit: number;
  search: string;
  snapshotType: Extract<EnvironmentSnapshotType, 'blueprint' | 'script'>;
}): ReactElement => {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const loader = useCallback(() => {
    return fetchCurrentEnvironmentSnapshots({
      snapshotType,
      limit,
      search: search || undefined,
    });
  }, [limit, search, snapshotType]);
  const state = usePollingState(loader, pollIntervalMs);

  return (
    <section className="panel">
      <header className="panel__header">
        <h3>{snapshotType === 'blueprint' ? 'Blueprint Snapshots' : 'Script Snapshots'}</h3>
        <p>
          Latest capture: {formatDateTime(state.data?.capturedAt ?? null)} · Showing {state.data?.snapshots.length ?? 0}
          {' / '}
          {formatNumber(state.data?.total ?? 0)}
        </p>
      </header>

      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          void state.refresh();
        }}
      >
        Refresh
      </button>

      {state.error ? <p className="error-text">{state.error}</p> : null}
      {state.loading && !state.data ? <p className="muted">Loading snapshots...</p> : null}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Resource</th>
              <th>Label</th>
              <th>Captured</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {(state.data?.snapshots ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No {snapshotType} snapshots found for the latest capture.
                </td>
              </tr>
            ) : (
              (state.data?.snapshots ?? []).map((row) => {
                const expanded = expandedId === row.id;
                return (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.snapshotType}</td>
                    <td className="mono">{row.resourceId}</td>
                    <td>{row.label || '-'}</td>
                    <td>{formatDateTime(row.capturedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--tiny"
                        onClick={() => {
                          setExpandedId(expanded ? null : row.id);
                        }}
                      >
                        {expanded ? 'Hide' : 'Show'}
                      </button>
                      {expanded ? <pre className="json-preview">{JSON.stringify(row.metadata, null, 2)}</pre> : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const EntitySnapshotsPane = ({
  pollIntervalMs,
  limit,
  search,
  domain,
}: {
  pollIntervalMs: number;
  limit: number;
  search: string;
  domain: string;
}): ReactElement => {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const loader = useCallback(() => {
    return fetchCurrentEntitySnapshots({
      limit,
      search: search || undefined,
      domain: domain || undefined,
    });
  }, [domain, limit, search]);
  const state = usePollingState(loader, pollIntervalMs);

  return (
    <section className="panel">
      <header className="panel__header">
        <h3>Entity Snapshots</h3>
        <p>
          Latest captured row: {formatDateTime(state.data?.latestCapturedAt ?? null)} · Showing{' '}
          {state.data?.snapshots.length ?? 0} / {formatNumber(state.data?.total ?? 0)}
        </p>
      </header>

      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          void state.refresh();
        }}
      >
        Refresh
      </button>

      {state.error ? <p className="error-text">{state.error}</p> : null}
      {state.loading && !state.data ? <p className="muted">Loading snapshots...</p> : null}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Entity</th>
              <th>Domain</th>
              <th>State</th>
              <th>Captured</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {(state.data?.snapshots ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No entity snapshots found for the current filter.
                </td>
              </tr>
            ) : (
              (state.data?.snapshots ?? []).map((row) => {
                const expanded = expandedId === row.id;
                return (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td className="mono">{row.entityId}</td>
                    <td>{row.domain || '-'}</td>
                    <td>{row.state || '-'}</td>
                    <td>{formatDateTime(row.capturedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--tiny"
                        onClick={() => {
                          setExpandedId(expanded ? null : row.id);
                        }}
                      >
                        {expanded ? 'Hide' : 'Show'}
                      </button>
                      {expanded ? (
                        <pre className="json-preview">
                          {JSON.stringify(
                            {
                              contextId: row.contextId,
                              sourceEventId: row.sourceEventId,
                              attributes: row.attributes,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const SnapshotsPage = ({ pollIntervalMs }: { pollIntervalMs: number }): ReactElement => {
  const [view, setView] = useState<'automation' | 'blueprint' | 'script' | 'entity'>('automation');
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [limitInput, setLimitInput] = useState('200');
  const limit = parseLimitInput(limitInput, 200);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Snapshot Explorer</h2>
          <p>Inspect latest automation, blueprint, script, and entity snapshot rows stored in Postgres.</p>
        </div>
      </header>

      <section className="panel">
        <div className="toolbar toolbar--filters">
          <label>
            Snapshot Type
            <select
              value={view}
              onChange={(event) => {
                setView(event.target.value as 'automation' | 'blueprint' | 'script' | 'entity');
              }}
            >
              <option value="automation">Automation</option>
              <option value="blueprint">Blueprint</option>
              <option value="script">Script</option>
              <option value="entity">Entity</option>
            </select>
          </label>
          <label>
            Search
            <input
              value={search}
              placeholder="resource id, alias, or state"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </label>
          <label>
            Limit
            <input
              value={limitInput}
              type="number"
              min={1}
              max={500}
              onChange={(event) => {
                setLimitInput(event.target.value);
              }}
            />
          </label>
          {view === 'entity' ? (
            <label>
              Domain
              <input
                value={domain}
                placeholder="light"
                onChange={(event) => {
                  setDomain(event.target.value);
                }}
              />
            </label>
          ) : null}
        </div>
      </section>

      {view === 'automation' ? <AutomationSnapshotsPane pollIntervalMs={pollIntervalMs} limit={limit} search={search} /> : null}
      {view === 'blueprint' ? (
        <EnvironmentSnapshotsPane pollIntervalMs={pollIntervalMs} limit={limit} search={search} snapshotType="blueprint" />
      ) : null}
      {view === 'script' ? (
        <EnvironmentSnapshotsPane pollIntervalMs={pollIntervalMs} limit={limit} search={search} snapshotType="script" />
      ) : null}
      {view === 'entity' ? (
        <EntitySnapshotsPane pollIntervalMs={pollIntervalMs} limit={limit} search={search} domain={domain} />
      ) : null}
    </section>
  );
};

const UsageCard = ({ label, readings }: { label: string; readings: ResourceUsageReading[] }): ReactElement => {
  return (
    <article className="panel usage-card">
      <header className="panel__header">
        <h3>{label}</h3>
        <p>{readings.length} readings</p>
      </header>
      {readings.length === 0 ? <p className="empty-state">No snapshots captured.</p> : null}
      {readings.slice(0, 8).map((reading) => {
        return (
          <div key={reading.entityId} className="usage-row">
            <div>
              <p className="mono">{reading.entityId}</p>
              <p>{reading.readingText}</p>
            </div>
            <div className="usage-row__meta">
              <strong>
                {reading.readingNumeric ?? '-'} {reading.unit || ''}
              </strong>
              <small>{formatDateTime(reading.capturedAt)}</small>
            </div>
          </div>
        );
      })}
    </article>
  );
};

const UsagePage = ({ pollIntervalMs }: { pollIntervalMs: number }): ReactElement => {
  const usage = usePollingState(fetchResourceUsage, pollIntervalMs);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h2>Resource Usage Snapshots</h2>
          <p>Latest energy, water, gas, and power measurements captured from Home Assistant.</p>
        </div>
      </header>

      {usage.error ? <p className="error-text">{usage.error}</p> : null}
      <p className="muted">Latest capture: {formatDateTime(usage.data?.capturedAt ?? null)}</p>

      <div className="usage-grid">
        <UsageCard label="Energy" readings={usage.data?.byType.energy ?? []} />
        <UsageCard label="Water" readings={usage.data?.byType.water ?? []} />
        <UsageCard label="Gas" readings={usage.data?.byType.gas ?? []} />
        <UsageCard label="Power" readings={usage.data?.byType.power ?? []} />
      </div>
    </section>
  );
};

const Header = ({
  operations,
  pollIntervalMs,
  onLogout,
}: {
  operations: ActionOperation[];
  pollIntervalMs: number;
  onLogout: () => void;
}): ReactElement => {
  const latestOperation = operations[0] ?? null;

  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">HA AI</p>
        <h1>Operator Console</h1>
      </div>
      <div className="app-header__meta">
        <p>
          Poll interval: <span className="mono">{pollIntervalMs}ms</span>
        </p>
        <p>
          Latest action:{' '}
          {latestOperation ? (
            <>
              <span className={statusClass(latestOperation.status)}>{latestOperation.status}</span>{' '}
              <span className="mono">{latestOperation.kind}</span>
            </>
          ) : (
            'none'
          )}
        </p>
        <button type="button" className="button button--ghost" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
};

export const App = ({ defaultPollIntervalMs }: AppProps): ReactElement => {
  const [authenticated, setAuthenticated] = useState(hasApiCredentials());
  const [operations, setOperations] = useState<ActionOperation[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const mergeOperation = useCallback((operation: ActionOperation) => {
    setOperations((current) => {
      const withoutExisting = current.filter((item) => item.id !== operation.id);
      return [operation, ...withoutExisting].slice(0, 20);
    });
  }, []);

  const trackAction = useCallback(
    (operationId: string) => {
      let timerId: number | undefined;

      const poll = async (): Promise<void> => {
        try {
          const latest = await fetchAction(operationId);
          mergeOperation(latest);

          if (latest.status === 'completed' || latest.status === 'failed') {
            return;
          }

          timerId = window.setTimeout(() => {
            void poll();
          }, 2000);
        } catch {
          timerId = window.setTimeout(() => {
            void poll();
          }, 3000);
        }
      };

      void poll();

      return () => {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      };
    },
    [mergeOperation],
  );

  const handleTriggerAction = useCallback(
    (kind: OperationKind, label: string) => {
      setConfirmState({
        title: `${label}?`,
        description: `This will queue '${kind}' immediately.`,
        confirmLabel: label,
        onConfirm: async () => {
          const operation = await runAction(kind);
          mergeOperation(operation);
          trackAction(operation.id);
        },
      });
    },
    [mergeOperation, trackAction],
  );

  const showConfirm = useCallback((state: ConfirmState) => {
    setConfirmState(state);
  }, []);

  const handleLogout = (): void => {
    clearApiCredentials();
    setAuthenticated(false);
    setOperations([]);
  };

  if (!authenticated) {
    return (
      <LoginGate
        onAuthenticated={() => {
          setAuthenticated(true);
        }}
      />
    );
  }

  return (
    <>
      <BrowserRouter>
        <div className="app-shell">
          <Header operations={operations} pollIntervalMs={defaultPollIntervalMs} onLogout={handleLogout} />
          <nav className="main-nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => (isActive ? 'main-nav__link main-nav__link--active' : 'main-nav__link')}
                >
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
          <main className="main-content">
            <Routes>
              <Route
                path="/"
                element={
                  <DashboardPage
                    pollIntervalMs={defaultPollIntervalMs}
                    onTriggerAction={handleTriggerAction}
                    operations={operations}
                  />
                }
              />
              <Route path="/runs" element={<RunsPage pollIntervalMs={defaultPollIntervalMs} />} />
              <Route
                path="/recommendations"
                element={<RecommendationsPage pollIntervalMs={defaultPollIntervalMs} showConfirm={showConfirm} />}
              />
              <Route path="/reports" element={<ReportsPage pollIntervalMs={defaultPollIntervalMs} />} />
              <Route path="/events" element={<EventsPage pollIntervalMs={defaultPollIntervalMs} />} />
              <Route path="/snapshots" element={<SnapshotsPage pollIntervalMs={defaultPollIntervalMs} />} />
              <Route path="/usage" element={<UsagePage pollIntervalMs={defaultPollIntervalMs} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
      {confirmState ? (
        <ConfirmModal
          state={confirmState}
          onClose={() => {
            setConfirmState(null);
          }}
        />
      ) : null}
    </>
  );
};
