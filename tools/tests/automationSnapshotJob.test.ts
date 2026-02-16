import type { Pool } from 'pg';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type AutomationSnapshotConfig,
  deriveHaHttpUrlFromWsUrl,
  deriveHaWsUrlFromHttpUrl,
  runAutomationSnapshotPass,
} from '../src/automationSnapshotJob.js';

type QueryCall = {
  sql: string;
  params: unknown[] | undefined;
};

const createConfig = (): AutomationSnapshotConfig => ({
  databaseUrl: 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai',
  haHttpUrl: 'http://ha.local:8123',
  haWsUrl: 'ws://ha.local:8123/api/websocket',
  haToken: 'token',
  timezone: 'UTC',
  scheduleTime: { hour: 3, minute: 15 },
  requestTimeoutMs: 5_000,
  wsRequestTimeoutMs: 5_000,
  includeConfig: true,
  configFetchConcurrency: 3,
  includeEnvironmentInventory: false,
  includeUsageSnapshots: true,
});

const createPool = (calls: QueryCall[]): Pool => {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };

  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
};

describe('deriveHaHttpUrlFromWsUrl', () => {
  test('converts websocket URL to HTTP base URL', () => {
    expect(deriveHaHttpUrlFromWsUrl('ws://192.168.1.50:8123/api/websocket')).toBe('http://192.168.1.50:8123');
    expect(deriveHaHttpUrlFromWsUrl('wss://ha.example.com/api/websocket')).toBe('https://ha.example.com');
    expect(deriveHaHttpUrlFromWsUrl(undefined)).toBeNull();
    expect(deriveHaHttpUrlFromWsUrl('not-a-url')).toBeNull();
  });
});

describe('deriveHaWsUrlFromHttpUrl', () => {
  test('converts http URL to websocket endpoint URL', () => {
    expect(deriveHaWsUrlFromHttpUrl('http://192.168.1.50:8123')).toBe('ws://192.168.1.50:8123/api/websocket');
    expect(deriveHaWsUrlFromHttpUrl('https://ha.example.com')).toBe('wss://ha.example.com/api/websocket');
    expect(deriveHaWsUrlFromHttpUrl(undefined)).toBeNull();
    expect(deriveHaWsUrlFromHttpUrl('not-a-url')).toBeNull();
  });
});

describe('runAutomationSnapshotPass', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('captures automation/script/scene snapshots and blueprint refs', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/api/states')) {
        return new Response(
          JSON.stringify([
            {
              entity_id: 'automation.kitchen_lights',
              state: 'on',
              attributes: { friendly_name: 'Kitchen Lights' },
              context: { id: 'ctx-a' },
            },
            {
              entity_id: 'script.goodnight',
              state: 'off',
              attributes: { friendly_name: 'Goodnight' },
              context: { id: 'ctx-b' },
            },
            {
              entity_id: 'scene.relax',
              state: 'unknown',
              attributes: { friendly_name: 'Relax Scene' },
              context: { id: 'ctx-c' },
            },
            {
              entity_id: 'light.kitchen',
              state: 'on',
            },
            {
              entity_id: 'sensor.daily_energy',
              state: '12.5',
              attributes: {
                friendly_name: 'Daily Energy',
                device_class: 'energy',
                unit_of_measurement: 'kWh',
              },
            },
            {
              entity_id: 'sensor.gas_meter_total',
              state: '21.2',
              attributes: {
                friendly_name: 'Gas Meter Total',
                device_class: 'gas',
                unit_of_measurement: 'm3',
              },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/config/automation/config/automation.kitchen_lights')) {
        return new Response(
          JSON.stringify({
            trigger: [{ platform: 'state' }],
            action: [{ service: 'light.turn_on' }],
            condition: [],
            use_blueprint: { path: 'my_pack/motion_lights.yaml', input: { area: 'kitchen' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/config/script/config/script.goodnight')) {
        return new Response(
          JSON.stringify({
            action: [{ service: 'light.turn_off' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/config/scene/config/scene.relax')) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.endsWith('/api/config/blueprint/list')) {
        return new Response(JSON.stringify([{ path: 'my_pack/motion_lights.yaml', name: 'Motion Lights Blueprint' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const calls: QueryCall[] = [];
    const stats = await runAutomationSnapshotPass(createPool(calls), createConfig());

    expect(stats.trackedEntities).toBe(3);
    expect(stats.insertedRows).toBe(4); // automation + script + scene + blueprint
    expect(stats.blueprintRowsInserted).toBe(1);
    expect(stats.configFetches).toBe(3);
    expect(stats.configFetchFailures).toBe(0);
    expect(stats.environmentRowsInserted).toBe(0);
    expect(stats.environmentCountsByType).toEqual({});
    expect(stats.usageRowsInserted).toBe(2);
    expect(stats.usageCountsByType).toEqual({
      energy: 1,
      gas: 1,
    });

    const insertCalls = calls.filter((call) => call.sql.includes('INSERT INTO automation_snapshots'));
    expect(insertCalls).toHaveLength(4);

    const insertedIds = insertCalls.map((call) => (call.params?.[0] as string) ?? '');
    expect(insertedIds).toContain('automation.kitchen_lights');
    expect(insertedIds).toContain('script.goodnight');
    expect(insertedIds).toContain('scene.relax');
    expect(insertedIds).toContain('blueprint:my_pack/motion_lights.yaml');
  });

  test('continues when per-entity config endpoints are unavailable', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/api/states')) {
        return new Response(
          JSON.stringify([{ entity_id: 'automation.porch', state: 'on', attributes: { friendly_name: 'Porch' } }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/config/automation/config/automation.porch')) {
        return new Response('missing', { status: 404 });
      }

      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const calls: QueryCall[] = [];
    const stats = await runAutomationSnapshotPass(createPool(calls), createConfig());

    expect(stats.trackedEntities).toBe(1);
    expect(stats.insertedRows).toBe(1);
    expect(stats.configFetches).toBe(1);
    expect(stats.configFetchFailures).toBe(1);
    expect(stats.environmentRowsInserted).toBe(0);
    expect(stats.environmentCountsByType).toEqual({});
    expect(stats.usageRowsInserted).toBe(0);
    expect(stats.usageCountsByType).toEqual({});
  });
});
