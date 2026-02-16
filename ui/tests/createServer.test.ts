import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionRunner } from '../src/server/actionRunner.js';
import type { UiConfig } from '../src/server/config.js';
import { createServer } from '../src/server/createServer.js';
import type { Queryable } from '../src/server/db.js';

const authHeader = `Basic ${Buffer.from('operator:secret').toString('base64')}`;

const createTestConfig = async (): Promise<{ config: UiConfig; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'ha-ai-ui-test-'));
  await writeFile(join(dir, 'index.html'), '<html><body>__UI_DEFAULT_POLL_MS__</body></html>', 'utf8');

  return {
    config: {
      host: '127.0.0.1',
      port: 5080,
      databaseUrl: 'postgresql://example',
      basicAuthUsername: 'operator',
      basicAuthPassword: 'secret',
      actionStatusTtlSeconds: 900,
      defaultPollIntervalMs: 10_000,
      buildVersion: 'test',
      webDistDir: dir,
      workspaceRoot: process.cwd(),
      yarnBin: 'yarn',
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const baseActionRunner = (): ActionRunner => {
  return {
    start(kind) {
      return {
        id: `op-${kind}`,
        kind,
        status: 'queued',
        message: 'Queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
        outputPreview: null,
      };
    },
    get(operationId) {
      return {
        id: operationId,
        kind: 'run-analysis',
        status: 'running',
        message: 'Running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
        outputPreview: null,
      };
    },
    stop() {},
  };
};

describe('createServer', () => {
  const cleanups: Array<() => Promise<void>> = [];
  const apps: Array<Awaited<ReturnType<typeof createServer>>> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }

    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('enforces basic auth for api routes and returns health when authenticated', async () => {
    const { config, cleanup } = await createTestConfig();
    cleanups.push(cleanup);

    const db: Queryable = {
      query: vi.fn(async () => ({
        rows: [{ db_time: new Date().toISOString(), db_version: 'PostgreSQL 18' }],
      })) as Queryable['query'],
    };

    const app = await createServer({
      config,
      db,
      actionRunner: baseActionRunner(),
    });
    apps.push(app);

    const unauthorized = await app.inject({ method: 'GET', url: '/api/health' });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: authHeader },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe('test');
  });

  it('returns 202 for manual action endpoints', async () => {
    const { config, cleanup } = await createTestConfig();
    cleanups.push(cleanup);

    const db: Queryable = {
      query: vi.fn(async () => ({ rows: [] })) as Queryable['query'],
    };

    const app = await createServer({
      config,
      db,
      actionRunner: baseActionRunner(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/actions/run-retention',
      headers: { authorization: authHeader },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation.kind).toBe('run-retention');
  });

  it('rejects recommendation state changes when recommendation is no longer proposed', async () => {
    const { config, cleanup } = await createTestConfig();
    cleanups.push(cleanup);

    const db: Queryable = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT status FROM recommendations')) {
          return { rows: [{ status: 'accepted' }] };
        }

        return { rows: [] };
      }) as Queryable['query'],
    };

    const app = await createServer({
      config,
      db,
      actionRunner: baseActionRunner(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/recommendations/42',
      headers: { authorization: authHeader },
      payload: { status: 'rejected' },
    });

    expect(response.statusCode).toBe(409);
  });
});
