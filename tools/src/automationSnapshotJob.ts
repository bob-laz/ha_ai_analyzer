import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { type RawData, WebSocket } from 'ws';

import { computeNextScheduledRunAt } from './analyticsJob.js';
import { createToolsPool } from './db.js';

type ScheduleTime = {
  hour: number;
  minute: number;
};

type SnapshotType = 'automation' | 'script' | 'scene' | 'blueprint';
type UsageSnapshotType = 'energy' | 'water' | 'gas' | 'power';

type HassContext = {
  id?: string | null;
  parent_id?: string | null;
  user_id?: string | null;
};

type HassState = {
  entity_id?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  context?: HassContext;
  last_changed?: string;
  last_updated?: string;
};

type BlueprintRef = {
  path: string;
  sourceEntityId: string;
  configDomain: 'automation' | 'script' | 'scene';
  input: Record<string, unknown>;
};

type SnapshotRow = {
  automationId: string;
  alias: string | null;
  isEnabled: boolean | null;
  triggerConfig: unknown[];
  actionConfig: unknown[];
  conditionsConfig: unknown[];
  metadata: Record<string, unknown>;
};

type EnvironmentSnapshotRow = {
  snapshotType: 'device' | 'service' | 'integration' | 'addon';
  resourceId: string;
  label: string | null;
  metadata: Record<string, unknown>;
};

type UsageSnapshotRow = {
  entityId: string;
  usageType: UsageSnapshotType;
  readingNumeric: number | null;
  readingText: string;
  unit: string | null;
  metadata: Record<string, unknown>;
};

export type AutomationSnapshotConfig = {
  databaseUrl: string;
  haHttpUrl: string;
  haWsUrl: string;
  haToken: string;
  timezone: string;
  scheduleTime: ScheduleTime;
  requestTimeoutMs: number;
  wsRequestTimeoutMs: number;
  includeConfig: boolean;
  configFetchConcurrency: number;
  includeEnvironmentInventory: boolean;
  includeUsageSnapshots: boolean;
};

export type AutomationSnapshotPassStats = {
  capturedAt: string;
  includeConfig: boolean;
  trackedEntities: number;
  insertedRows: number;
  configFetches: number;
  configFetchFailures: number;
  blueprintRowsInserted: number;
  environmentRowsInserted: number;
  environmentCountsByType: Record<string, number>;
  usageRowsInserted: number;
  usageCountsByType: Record<string, number>;
};

const TARGET_ENTITY_PREFIXES = ['automation.', 'script.', 'scene.'] as const;
const BLUEPRINT_LIST_PATH_CANDIDATES = [
  '/api/config/blueprint/list',
  '/api/config/blueprint/list/automation',
  '/api/config/blueprint/list/script',
];

const parseNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Math.floor(parseNumber(raw, fallback));
  return parsed > 0 ? parsed : fallback;
};

const parseScheduleTime = (raw: string | undefined): ScheduleTime => {
  const value = (raw ?? '03:15').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`AUTOMATION_SNAPSHOT_SCHEDULE_TIME must be HH:MM (24h), received '${value}'`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`AUTOMATION_SNAPSHOT_SCHEDULE_TIME is out of range: '${value}'`);
  }

  return { hour, minute };
};

const parseBoolean = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const toArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [value];
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const enabledFromState = (state: string | undefined): boolean | null => {
  if (state === 'on') {
    return true;
  }
  if (state === 'off') {
    return false;
  }
  return null;
};

const entityDomain = (entityId: string): SnapshotType | null => {
  if (entityId.startsWith('automation.')) {
    return 'automation';
  }
  if (entityId.startsWith('script.')) {
    return 'script';
  }
  if (entityId.startsWith('scene.')) {
    return 'scene';
  }
  return null;
};

const isTrackedEntity = (entityId: string): boolean => {
  return TARGET_ENTITY_PREFIXES.some((prefix) => entityId.startsWith(prefix));
};

const withTimeout = async (url: string, timeoutMs: number, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const wsRawToText = (raw: RawData): string => {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
};

export const deriveHaHttpUrlFromWsUrl = (haWsUrl: string | undefined): string | null => {
  if (!haWsUrl) {
    return null;
  }

  try {
    const parsed = new URL(haWsUrl);
    if (parsed.protocol === 'ws:') {
      parsed.protocol = 'http:';
    } else if (parsed.protocol === 'wss:') {
      parsed.protocol = 'https:';
    }

    if (parsed.pathname.endsWith('/api/websocket')) {
      parsed.pathname = parsed.pathname.slice(0, -'/api/websocket'.length) || '/';
    }

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

export const deriveHaWsUrlFromHttpUrl = (haHttpUrl: string | undefined): string | null => {
  if (!haHttpUrl) {
    return null;
  }

  try {
    const parsed = new URL(haHttpUrl);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:';
    } else if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:';
    }

    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/api/websocket';
    } else {
      parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/api/websocket`;
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const resolveConfig = (): AutomationSnapshotConfig => {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai';
  const haHttpUrl =
    process.env.HA_HTTP_URL?.trim() ||
    deriveHaHttpUrlFromWsUrl(process.env.HA_WS_URL) ||
    'http://homeassistant.local:8123';
  const haWsUrl =
    process.env.HA_WS_URL?.trim() ||
    deriveHaWsUrlFromHttpUrl(haHttpUrl) ||
    'ws://homeassistant.local:8123/api/websocket';
  const haToken = process.env.HA_TOKEN?.trim() ?? '';
  const timezone = process.env.AUTOMATION_SNAPSHOT_SCHEDULE_TIMEZONE ?? process.env.ANALYTICS_TIMEZONE ?? 'UTC';

  if (!haToken) {
    throw new Error('HA_TOKEN is required for automation snapshot sync.');
  }

  return {
    databaseUrl,
    haHttpUrl,
    haWsUrl,
    haToken,
    timezone,
    scheduleTime: parseScheduleTime(process.env.AUTOMATION_SNAPSHOT_SCHEDULE_TIME),
    requestTimeoutMs: parsePositiveInt(process.env.AUTOMATION_SNAPSHOT_REQUEST_TIMEOUT_MS, 10_000),
    wsRequestTimeoutMs: parsePositiveInt(process.env.AUTOMATION_SNAPSHOT_WS_REQUEST_TIMEOUT_MS, 10_000),
    includeConfig: parseBoolean(process.env.AUTOMATION_SNAPSHOT_INCLUDE_CONFIG, true),
    configFetchConcurrency: parsePositiveInt(process.env.AUTOMATION_SNAPSHOT_CONFIG_FETCH_CONCURRENCY, 5),
    includeEnvironmentInventory: parseBoolean(process.env.AUTOMATION_SNAPSHOT_INCLUDE_ENVIRONMENT_INVENTORY, true),
    includeUsageSnapshots: parseBoolean(process.env.AUTOMATION_SNAPSHOT_INCLUDE_USAGE_SNAPSHOTS, true),
  };
};

const fetchWsResult = async (
  config: AutomationSnapshotConfig,
  commandType: string,
  commandPayload: Record<string, unknown> = {},
  optional = false,
): Promise<unknown | null> => {
  return await new Promise<unknown | null>((resolve, reject) => {
    const ws = new WebSocket(config.haWsUrl);
    const requestId = 1;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        ws.close();
      } catch {
        // noop
      }
      fn();
    };

    const timeoutId = setTimeout(() => {
      if (optional) {
        finish(() => resolve(null));
        return;
      }
      finish(() => reject(new Error(`Timed out waiting for websocket response (${commandType})`)));
    }, config.wsRequestTimeoutMs);

    ws.on('error', (error) => {
      if (optional) {
        finish(() => resolve(null));
        return;
      }
      finish(() => reject(error));
    });

    ws.on('close', () => {
      if (!settled && !optional) {
        finish(() => reject(new Error(`Websocket closed before receiving result for ${commandType}`)));
      }
    });

    ws.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(wsRawToText(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = typeof message.type === 'string' ? message.type : null;
      if (!type) {
        return;
      }

      if (type === 'auth_required') {
        ws.send(
          JSON.stringify({
            type: 'auth',
            access_token: config.haToken,
          }),
        );
        return;
      }

      if (type === 'auth_invalid') {
        if (optional) {
          finish(() => resolve(null));
          return;
        }
        finish(() => reject(new Error('Home Assistant websocket auth rejected token for snapshot sync')));
        return;
      }

      if (type === 'auth_ok') {
        ws.send(
          JSON.stringify({
            id: requestId,
            type: commandType,
            ...commandPayload,
          }),
        );
        return;
      }

      if (type !== 'result') {
        return;
      }

      if (typeof message.id !== 'number' || message.id !== requestId) {
        return;
      }

      if (message.success === true) {
        finish(() => resolve(message.result ?? null));
        return;
      }

      if (optional) {
        finish(() => resolve(null));
        return;
      }

      let errorMessage = `Home Assistant websocket command failed (${commandType})`;
      if (message.error && typeof message.error === 'object') {
        const maybeMessage = (message.error as { message?: unknown }).message;
        if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
          errorMessage = maybeMessage;
        }
      }
      finish(() => reject(new Error(errorMessage)));
    });
  });
};

const fetchJson = async (config: AutomationSnapshotConfig, path: string, optional = false): Promise<unknown | null> => {
  const response = await withTimeout(`${config.haHttpUrl}${path}`, config.requestTimeoutMs, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.haToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (optional) {
      return null;
    }
    const body = await response.text();
    throw new Error(
      `Home Assistant request failed: GET ${path} -> ${response.status} ${response.statusText} (${body})`,
    );
  }

  return await response.json();
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await mapItem(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: cappedConcurrency }, () => worker()));
  return results;
};

const extractBlueprintRef = (
  configDomain: 'automation' | 'script' | 'scene',
  sourceEntityId: string,
  configPayload: unknown,
): BlueprintRef | null => {
  const record = toRecord(configPayload);
  const useBlueprint = toRecord(record.use_blueprint);
  const path = typeof useBlueprint.path === 'string' ? useBlueprint.path.trim() : '';
  if (!path) {
    return null;
  }

  return {
    path,
    sourceEntityId,
    configDomain,
    input: toRecord(useBlueprint.input),
  };
};

const extractConfigForEntity = async (
  config: AutomationSnapshotConfig,
  entityId: string,
): Promise<{
  trigger: unknown[];
  action: unknown[];
  condition: unknown[];
  rawConfig: unknown | null;
  failed: boolean;
}> => {
  const domain = entityDomain(entityId);
  if (!domain || domain === 'blueprint') {
    return { trigger: [], action: [], condition: [], rawConfig: null, failed: false };
  }

  if (!config.includeConfig) {
    return { trigger: [], action: [], condition: [], rawConfig: null, failed: false };
  }

  let payload: unknown | null;
  try {
    payload = await fetchJson(config, `/api/config/${domain}/config/${encodeURIComponent(entityId)}`, true);
  } catch {
    return { trigger: [], action: [], condition: [], rawConfig: null, failed: true };
  }

  if (payload === null) {
    return { trigger: [], action: [], condition: [], rawConfig: null, failed: true };
  }

  const asRecord = toRecord(payload);
  return {
    trigger: toArray(asRecord.trigger),
    action: toArray(asRecord.action),
    condition: toArray(asRecord.condition),
    rawConfig: asRecord,
    failed: false,
  };
};

const fetchBlueprintRows = async (
  config: AutomationSnapshotConfig,
  discoveredRefs: BlueprintRef[],
): Promise<SnapshotRow[]> => {
  const rows = new Map<string, SnapshotRow>();

  // First capture blueprint references from automation/script/scene configs.
  for (const ref of discoveredRefs) {
    const key = `blueprint:${ref.path}`;
    rows.set(key, {
      automationId: key,
      alias: ref.path.split('/').at(-1) ?? ref.path,
      isEnabled: null,
      triggerConfig: [],
      actionConfig: [],
      conditionsConfig: [],
      metadata: {
        snapshotType: 'blueprint',
        blueprintPath: ref.path,
        sourceEntityIds: [ref.sourceEntityId],
        sourceDomains: [ref.configDomain],
        input: ref.input,
      },
    });
  }

  // Then attempt to enumerate blueprint metadata from HA (optional).
  for (const path of BLUEPRINT_LIST_PATH_CANDIDATES) {
    let payload: unknown | null;
    try {
      payload = await fetchJson(config, path, true);
    } catch {
      continue;
    }

    if (!payload) {
      continue;
    }

    const payloadRows = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { blueprints?: unknown[] }).blueprints)
        ? ((payload as { blueprints?: unknown[] }).blueprints ?? [])
        : [];

    for (const row of payloadRows) {
      const asRecord = toRecord(row);
      const blueprintPathValue =
        (typeof asRecord.path === 'string' && asRecord.path.trim()) ||
        (typeof asRecord.blueprint_path === 'string' && asRecord.blueprint_path.trim()) ||
        null;
      if (!blueprintPathValue) {
        continue;
      }

      const key = `blueprint:${blueprintPathValue}`;
      const existing = rows.get(key);
      const metadataBase = {
        snapshotType: 'blueprint',
        blueprintPath: blueprintPathValue,
        listedBy: path,
        raw: asRecord,
      };

      if (existing) {
        rows.set(key, {
          ...existing,
          metadata: {
            ...existing.metadata,
            listedBy: path,
            raw: asRecord,
          },
        });
        continue;
      }

      rows.set(key, {
        automationId: key,
        alias: (typeof asRecord.name === 'string' && asRecord.name) || blueprintPathValue.split('/').at(-1) || null,
        isEnabled: null,
        triggerConfig: [],
        actionConfig: [],
        conditionsConfig: [],
        metadata: metadataBase,
      });
    }
  }

  return [...rows.values()];
};

const buildServiceRows = (servicesPayload: unknown): EnvironmentSnapshotRow[] => {
  if (!Array.isArray(servicesPayload)) {
    return [];
  }

  const rows: EnvironmentSnapshotRow[] = [];
  for (const domainEntry of servicesPayload) {
    const asRecord = toRecord(domainEntry);
    const domain = typeof asRecord.domain === 'string' ? asRecord.domain.trim() : '';
    if (!domain) {
      continue;
    }

    const services = toRecord(asRecord.services);
    for (const [serviceName, serviceData] of Object.entries(services)) {
      const normalizedServiceName = serviceName.trim();
      if (!normalizedServiceName) {
        continue;
      }

      const serviceRecord = toRecord(serviceData);
      rows.push({
        snapshotType: 'service',
        resourceId: `${domain}.${normalizedServiceName}`,
        label: typeof serviceRecord.name === 'string' ? serviceRecord.name : null,
        metadata: {
          domain,
          service: normalizedServiceName,
          definition: serviceRecord,
        },
      });
    }
  }

  return rows;
};

const buildDeviceRows = (devicePayload: unknown): EnvironmentSnapshotRow[] => {
  if (!Array.isArray(devicePayload)) {
    return [];
  }

  const rows: EnvironmentSnapshotRow[] = [];
  for (const device of devicePayload) {
    const record = toRecord(device);
    const resourceId = typeof record.id === 'string' ? record.id : null;
    if (!resourceId) {
      continue;
    }

    const label =
      (typeof record.name_by_user === 'string' && record.name_by_user) ||
      (typeof record.name === 'string' && record.name) ||
      (typeof record.model === 'string' && record.model) ||
      resourceId;

    rows.push({
      snapshotType: 'device',
      resourceId,
      label,
      metadata: record,
    });
  }

  return rows;
};

const buildIntegrationRows = (entriesPayload: unknown): EnvironmentSnapshotRow[] => {
  if (!Array.isArray(entriesPayload)) {
    return [];
  }

  const rows: EnvironmentSnapshotRow[] = [];
  for (const entry of entriesPayload) {
    const record = toRecord(entry);
    const resourceId = typeof record.entry_id === 'string' ? record.entry_id : null;
    if (!resourceId) {
      continue;
    }

    const label = typeof record.title === 'string' ? record.title : null;

    rows.push({
      snapshotType: 'integration',
      resourceId,
      label,
      metadata: {
        domain: typeof record.domain === 'string' ? record.domain : null,
        source: typeof record.source === 'string' ? record.source : null,
        state: typeof record.state === 'string' ? record.state : null,
        disabledBy: record.disabled_by ?? null,
        raw: record,
      },
    });
  }

  return rows;
};

const buildAddonRows = (addonsPayload: unknown): EnvironmentSnapshotRow[] => {
  const addonRows = Array.isArray(addonsPayload)
    ? addonsPayload
    : Array.isArray((addonsPayload as { addons?: unknown[] })?.addons)
      ? ((addonsPayload as { addons?: unknown[] }).addons ?? [])
      : Array.isArray((addonsPayload as { data?: { addons?: unknown[] } })?.data?.addons)
        ? ((addonsPayload as { data?: { addons?: unknown[] } }).data?.addons ?? [])
        : [];

  const rows: EnvironmentSnapshotRow[] = [];
  for (const addon of addonRows) {
    const record = toRecord(addon);
    const resourceId =
      (typeof record.slug === 'string' && record.slug) || (typeof record.addon === 'string' && record.addon) || null;
    if (!resourceId) {
      continue;
    }

    const label = typeof record.name === 'string' ? record.name : resourceId;
    rows.push({
      snapshotType: 'addon',
      resourceId,
      label,
      metadata: record,
    });
  }

  return rows;
};

const collectEnvironmentRows = async (config: AutomationSnapshotConfig): Promise<EnvironmentSnapshotRow[]> => {
  if (!config.includeEnvironmentInventory) {
    return [];
  }

  const [servicesPayload, devicesPayload, entriesPayload, addonsPayload] = await Promise.all([
    fetchJson(config, '/api/services', true),
    fetchWsResult(config, 'config/device_registry/list', {}, true),
    fetchWsResult(config, 'config_entries/get', {}, true),
    fetchJson(config, '/api/hassio/addons', true),
  ]);

  const rows = [
    ...buildServiceRows(servicesPayload),
    ...buildDeviceRows(devicesPayload),
    ...buildIntegrationRows(entriesPayload),
    ...buildAddonRows(addonsPayload),
  ];

  const deduped = new Map<string, EnvironmentSnapshotRow>();
  for (const row of rows) {
    deduped.set(`${row.snapshotType}::${row.resourceId}`, row);
  }

  return [...deduped.values()];
};

const USAGE_UNIT_HINTS: Array<{ usageType: UsageSnapshotType; pattern: RegExp }> = [
  { usageType: 'energy', pattern: /^(k?wh|mwh|gwh)$/i },
  { usageType: 'water', pattern: /^(l|ml|gal|gallon|m3|m³|ft3|ft³)$/i },
  { usageType: 'gas', pattern: /^(m3|m³|ft3|ft³|therm|therms|ccf)$/i },
  { usageType: 'power', pattern: /^(w|kw|mw)$/i },
];

const inferUsageType = (entityId: string, deviceClassRaw: unknown, unitRaw: unknown): UsageSnapshotType | null => {
  const deviceClass = typeof deviceClassRaw === 'string' ? deviceClassRaw.trim().toLowerCase() : '';
  if (deviceClass === 'energy') {
    return 'energy';
  }
  if (deviceClass === 'water') {
    return 'water';
  }
  if (deviceClass === 'gas') {
    return 'gas';
  }
  if (deviceClass === 'power') {
    return 'power';
  }

  const unit = typeof unitRaw === 'string' ? unitRaw.trim() : '';
  for (const hint of USAGE_UNIT_HINTS) {
    if (hint.pattern.test(unit)) {
      if (hint.usageType === 'water' || hint.usageType === 'gas') {
        const normalizedId = entityId.toLowerCase();
        if (normalizedId.includes('gas')) {
          return 'gas';
        }
        if (normalizedId.includes('water')) {
          return 'water';
        }
      }
      return hint.usageType;
    }
  }

  const normalizedId = entityId.toLowerCase();
  if (normalizedId.includes('energy')) {
    return 'energy';
  }
  if (normalizedId.includes('water')) {
    return 'water';
  }
  if (normalizedId.includes('gas')) {
    return 'gas';
  }
  if (normalizedId.includes('power')) {
    return 'power';
  }

  return null;
};

const toOptionalNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildUsageRows = (states: HassState[], includeUsageSnapshots: boolean): UsageSnapshotRow[] => {
  if (!includeUsageSnapshots) {
    return [];
  }

  const rows: UsageSnapshotRow[] = [];
  for (const state of states) {
    const entityId = typeof state.entity_id === 'string' ? state.entity_id : '';
    if (!entityId) {
      continue;
    }
    if (!entityId.startsWith('sensor.') && !entityId.startsWith('utility_meter.')) {
      continue;
    }

    const attributes = toRecord(state.attributes);
    const usageType = inferUsageType(entityId, attributes.device_class, attributes.unit_of_measurement);
    if (!usageType) {
      continue;
    }

    const readingText = typeof state.state === 'string' ? state.state : String(state.state ?? '');
    const readingNumeric = toOptionalNumber(readingText);
    const unit = typeof attributes.unit_of_measurement === 'string' ? attributes.unit_of_measurement : null;

    rows.push({
      entityId,
      usageType,
      readingNumeric,
      readingText,
      unit,
      metadata: {
        friendlyName: typeof attributes.friendly_name === 'string' ? attributes.friendly_name : null,
        deviceClass: typeof attributes.device_class === 'string' ? attributes.device_class : null,
        stateClass: typeof attributes.state_class === 'string' ? attributes.state_class : null,
        source: 'home_assistant_state',
      },
    });
  }

  const deduped = new Map<string, UsageSnapshotRow>();
  for (const row of rows) {
    deduped.set(row.entityId, row);
  }

  return [...deduped.values()];
};

const INSERT_SNAPSHOT_SQL = `
INSERT INTO automation_snapshots (
  automation_id,
  alias,
  is_enabled,
  trigger_config,
  action_config,
  conditions_config,
  metadata,
  captured_at
)
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::timestamptz)
`;

const INSERT_ENVIRONMENT_SNAPSHOT_SQL = `
INSERT INTO ha_environment_snapshots (
  snapshot_type,
  resource_id,
  label,
  metadata,
  captured_at
)
VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
`;

const INSERT_USAGE_SNAPSHOT_SQL = `
INSERT INTO ha_usage_snapshots (
  entity_id,
  usage_type,
  reading_numeric,
  reading_text,
  unit,
  metadata,
  captured_at
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
`;

export const runAutomationSnapshotPass = async (
  pool: Pool,
  config: AutomationSnapshotConfig,
): Promise<AutomationSnapshotPassStats> => {
  const capturedAt = new Date().toISOString();
  const statesPayload = await fetchJson(config, '/api/states');
  if (!Array.isArray(statesPayload)) {
    throw new Error('Unexpected Home Assistant /api/states response shape; expected array.');
  }

  const allStates = statesPayload.map((row) => row as HassState);
  const trackedStates = allStates.filter((row) => typeof row.entity_id === 'string' && isTrackedEntity(row.entity_id));

  let configFetches = 0;
  let configFetchFailures = 0;
  const blueprintRefs: BlueprintRef[] = [];

  const entityRows = await mapWithConcurrency(trackedStates, config.configFetchConcurrency, async (state) => {
    const entityId = state.entity_id as string;
    const snapshotType = entityDomain(entityId) ?? 'automation';
    const attributes = toRecord(state.attributes);

    let trigger: unknown[] = [];
    let action: unknown[] = [];
    let condition: unknown[] = [];
    let rawConfig: unknown | null = null;

    if (config.includeConfig) {
      configFetches += 1;
      const configResult = await extractConfigForEntity(config, entityId);
      trigger = configResult.trigger;
      action = configResult.action;
      condition = configResult.condition;
      rawConfig = configResult.rawConfig;
      if (configResult.failed) {
        configFetchFailures += 1;
      } else {
        const blueprintRef = extractBlueprintRef(
          snapshotType === 'scene' ? 'scene' : snapshotType === 'script' ? 'script' : 'automation',
          entityId,
          rawConfig,
        );
        if (blueprintRef) {
          blueprintRefs.push(blueprintRef);
        }
      }
    }

    const alias = typeof attributes.friendly_name === 'string' ? attributes.friendly_name : null;
    return {
      automationId: entityId,
      alias,
      isEnabled: enabledFromState(state.state),
      triggerConfig: trigger,
      actionConfig: action,
      conditionsConfig: condition,
      metadata: {
        snapshotType,
        state: state.state ?? null,
        attributes,
        context: state.context ?? null,
        lastChanged: state.last_changed ?? null,
        lastUpdated: state.last_updated ?? null,
        rawConfig,
      },
    } satisfies SnapshotRow;
  });

  const blueprintRows = await fetchBlueprintRows(config, blueprintRefs);
  const allRows = [...entityRows, ...blueprintRows];
  const environmentRows = await collectEnvironmentRows(config);
  const usageRows = buildUsageRows(allStates, config.includeUsageSnapshots);

  let insertedRows = 0;
  let environmentRowsInserted = 0;
  const environmentCountsByType: Record<string, number> = {};
  let usageRowsInserted = 0;
  const usageCountsByType: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of allRows) {
      await client.query(INSERT_SNAPSHOT_SQL, [
        row.automationId,
        row.alias,
        row.isEnabled,
        JSON.stringify(row.triggerConfig),
        JSON.stringify(row.actionConfig),
        JSON.stringify(row.conditionsConfig),
        JSON.stringify(row.metadata),
        capturedAt,
      ]);
      insertedRows += 1;
    }

    for (const row of environmentRows) {
      await client.query(INSERT_ENVIRONMENT_SNAPSHOT_SQL, [
        row.snapshotType,
        row.resourceId,
        row.label,
        JSON.stringify(row.metadata),
        capturedAt,
      ]);
      environmentRowsInserted += 1;
      environmentCountsByType[row.snapshotType] = (environmentCountsByType[row.snapshotType] ?? 0) + 1;
    }

    for (const row of usageRows) {
      await client.query(INSERT_USAGE_SNAPSHOT_SQL, [
        row.entityId,
        row.usageType,
        row.readingNumeric,
        row.readingText,
        row.unit,
        JSON.stringify(row.metadata),
        capturedAt,
      ]);
      usageRowsInserted += 1;
      usageCountsByType[row.usageType] = (usageCountsByType[row.usageType] ?? 0) + 1;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    capturedAt,
    includeConfig: config.includeConfig,
    trackedEntities: trackedStates.length,
    insertedRows,
    configFetches,
    configFetchFailures,
    blueprintRowsInserted: blueprintRows.length,
    environmentRowsInserted,
    environmentCountsByType,
    usageRowsInserted,
    usageCountsByType,
  };
};

const runOnce = async (pool: Pool, config: AutomationSnapshotConfig): Promise<void> => {
  const stats = await runAutomationSnapshotPass(pool, config);
  console.info('automation snapshot pass completed', stats);
};

const runScheduler = async (pool: Pool, config: AutomationSnapshotConfig): Promise<void> => {
  // Run immediately on service startup so automation context is available right away.
  try {
    await runOnce(pool, config);
  } catch (error) {
    console.error('initial automation snapshot pass failed', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }

  while (true) {
    const now = new Date();
    const nextRunAt = computeNextScheduledRunAt(now, config.scheduleTime, config.timezone);
    const waitMs = Math.max(0, nextRunAt.getTime() - now.getTime());

    console.info('next automation snapshot run planned', {
      now: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      waitMs,
      timezone: config.timezone,
      scheduleTime: `${String(config.scheduleTime.hour).padStart(2, '0')}:${String(config.scheduleTime.minute).padStart(2, '0')}`,
    });

    await sleep(waitMs);

    try {
      await runOnce(pool, config);
    } catch (error) {
      console.error('automation snapshot pass failed', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }
};

const parseMode = (args: string[]): 'once' | 'schedule' => {
  const knownFlags = new Set(['--once', '--schedule']);
  for (const arg of args) {
    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown automationSnapshotJob argument '${arg}'. Supported flags: --once, --schedule`);
    }
  }

  if (args.includes('--once')) {
    return 'once';
  }

  return 'schedule';
};

export const runAutomationSnapshotJob = async (args: string[] = process.argv.slice(2)): Promise<void> => {
  const config = resolveConfig();
  const pool = createToolsPool(config.databaseUrl);
  const mode = parseMode(args);

  try {
    if (mode === 'once') {
      await runOnce(pool, config);
      return;
    }

    await runScheduler(pool, config);
  } finally {
    await pool.end();
  }
};

const isDirectExecution = (): boolean => {
  if (!process.argv[1]) {
    return false;
  }

  return fileURLToPath(import.meta.url) === process.argv[1];
};

if (isDirectExecution()) {
  void runAutomationSnapshotJob().catch((error) => {
    console.error('automation snapshot job failed', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 1;
  });
}
