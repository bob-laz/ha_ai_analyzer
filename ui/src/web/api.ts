import type {
  ActionAcceptedResponse,
  ActionOperation,
  HealthResponse,
  LatestReportResponse,
  OperationKind,
  OverviewResponse,
  RecentAnomaliesResponse,
  RecentEventsResponse,
  RecommendationRow,
  RecommendationStatus,
  RecommendationsResponse,
  RecommendationUpdateResponse,
  ResourceUsageResponse,
  RunsResponse,
} from '../shared/types.js';

const AUTH_STORAGE_KEY = 'ha-ai-operator-basic-auth';

const makeAuthHeader = (username: string, password: string): string => {
  return `Basic ${btoa(`${username}:${password}`)}`;
};

export const saveApiCredentials = (username: string, password: string): void => {
  sessionStorage.setItem(AUTH_STORAGE_KEY, makeAuthHeader(username, password));
};

export const clearApiCredentials = (): void => {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
};

export const hasApiCredentials = (): boolean => {
  return Boolean(sessionStorage.getItem(AUTH_STORAGE_KEY));
};

const getAuthHeader = (): string | null => {
  return sessionStorage.getItem(AUTH_STORAGE_KEY);
};

const apiRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const authHeader = getAuthHeader();
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    clearApiCredentials();
    throw new Error('Authentication failed. Re-enter UI credentials.');
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
};

export const fetchOverview = (): Promise<OverviewResponse> => {
  return apiRequest<OverviewResponse>('/api/overview');
};

export const fetchHealth = (): Promise<HealthResponse> => {
  return apiRequest<HealthResponse>('/api/health');
};

export const fetchRuns = (params: { limit?: number; runType?: string; status?: string }): Promise<RunsResponse> => {
  const query = new URLSearchParams();
  if (params.limit) {
    query.set('limit', String(params.limit));
  }
  if (params.runType) {
    query.set('runType', params.runType);
  }
  if (params.status) {
    query.set('status', params.status);
  }

  const suffix = query.toString();
  return apiRequest<RunsResponse>(`/api/runs${suffix ? `?${suffix}` : ''}`);
};

export const fetchRecommendations = (params: {
  limit?: number;
  status?: RecommendationStatus;
}): Promise<RecommendationsResponse> => {
  const query = new URLSearchParams();
  if (params.limit) {
    query.set('limit', String(params.limit));
  }
  if (params.status) {
    query.set('status', params.status);
  }

  const suffix = query.toString();
  return apiRequest<RecommendationsResponse>(`/api/recommendations${suffix ? `?${suffix}` : ''}`);
};

export const fetchLatestReport = (reportType: 'llm_analysis' | 'daily_home_summary'): Promise<LatestReportResponse> => {
  return apiRequest<LatestReportResponse>(`/api/reports/latest?type=${reportType}`);
};

export const fetchRecentEvents = (limit = 200): Promise<RecentEventsResponse> => {
  return apiRequest<RecentEventsResponse>(`/api/events/recent?limit=${encodeURIComponent(limit)}`);
};

export const fetchRecentAnomalies = (limit = 30): Promise<RecentAnomaliesResponse> => {
  return apiRequest<RecentAnomaliesResponse>(`/api/anomalies/recent?limit=${encodeURIComponent(limit)}`);
};

export const fetchResourceUsage = (): Promise<ResourceUsageResponse> => {
  return apiRequest<ResourceUsageResponse>('/api/resource-usage/latest');
};

export const runAction = async (kind: OperationKind): Promise<ActionOperation> => {
  const pathByKind: Record<OperationKind, string> = {
    'run-analysis': '/api/actions/run-analysis',
    'run-daily-summary': '/api/actions/run-daily-summary',
    'run-automation-snapshots': '/api/actions/run-automation-snapshots',
    'run-retention': '/api/actions/run-retention',
  };

  const response = await apiRequest<ActionAcceptedResponse>(pathByKind[kind], {
    method: 'POST',
    body: JSON.stringify({}),
  });

  return response.operation;
};

export const fetchAction = async (operationId: string): Promise<ActionOperation> => {
  const response = await apiRequest<ActionAcceptedResponse>(`/api/actions/${encodeURIComponent(operationId)}`);
  return response.operation;
};

export const updateRecommendationStatus = async (
  recommendationId: number,
  nextStatus: Extract<RecommendationStatus, 'accepted' | 'rejected'>,
): Promise<RecommendationRow> => {
  const response = await apiRequest<RecommendationUpdateResponse>(
    `/api/recommendations/${encodeURIComponent(recommendationId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    },
  );

  return response.recommendation;
};
