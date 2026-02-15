import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';

import type { CollectorConfig } from '../src/config.js';
import { BatchedEventWriter } from '../src/db.js';
import { HAEventCollector } from '../src/haClient.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? '';
const shouldRun = TEST_DB_URL.length > 0;

describe.skipIf(!shouldRun)('collector integration', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        domain TEXT,
        entity_id TEXT,
        service TEXT,
        context_id TEXT,
        parent_context_id TEXT,
        user_id TEXT,
        data JSONB NOT NULL,
        dedupe_key TEXT,
        collector_instance TEXT NOT NULL DEFAULT 'test',
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_key_unique_test ON events (dedupe_key)');
    await pool.query('TRUNCATE TABLE events RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  test('writes normalized websocket event into postgres', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const address = wss.address();
    if (!address || typeof address === 'string') {
      throw new Error('unable to resolve test websocket port');
    }

    const eventPublished = new Promise<void>((resolve) => {
      wss.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'auth_required' }));

        socket.once('message', () => {
          socket.send(JSON.stringify({ type: 'auth_ok' }));

          socket.once('message', (rawSubscribe) => {
            const subscribe = JSON.parse(rawSubscribe.toString()) as { id: number };
            socket.send(JSON.stringify({ id: subscribe.id, type: 'result', success: true, result: null }));

            socket.send(
              JSON.stringify({
                id: subscribe.id,
                type: 'event',
                event: {
                  event_type: 'state_changed',
                  time_fired: '2026-01-01T00:00:00.000Z',
                  context: { id: 'ctx-1', parent_id: null, user_id: 'user-1' },
                  data: {
                    entity_id: 'light.kitchen',
                    new_state: { entity_id: 'light.kitchen', state: 'on' },
                  },
                },
              }),
            );
            resolve();
          });
        });
      });
    });

    const config: CollectorConfig = {
      databaseUrl: TEST_DB_URL,
      haWsUrl: `ws://127.0.0.1:${address.port}`,
      haToken: 'test-token',
      eventTypes: ['state_changed'],
      domainAllowlist: new Set(),
      domainExcludelist: new Set(),
      batchSize: 1,
      flushIntervalSeconds: 0.1,
      reconnectInitialSeconds: 0.05,
      reconnectMaxSeconds: 0.1,
      reconnectJitterRatio: 0,
      maxBufferedEvents: 100,
      overflowPolicy: 'drop_newest',
      retryBackpressureDelayMs: 10,
      collectorInstanceId: 'collector-test',
      logLevel: 'info',
    };

    const writer = new BatchedEventWriter(pool, config.collectorInstanceId, 1, 1000, 100, 'drop_newest');
    const collector = new HAEventCollector(config, writer);
    const originalAdd = writer.add.bind(writer);

    writer.add = async (event) => {
      const accepted = await originalAdd(event);
      collector.stop();
      return accepted;
    };

    writer.start();
    await collector.runForever();
    await eventPublished;
    await writer.stop();

    const row = await pool.query(
      "SELECT event_type, domain, entity_id, context_id, collector_instance FROM events WHERE context_id = 'ctx-1' LIMIT 1",
    );

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });

    expect(row.rowCount).toBe(1);
    expect(row.rows[0]?.event_type).toBe('state_changed');
    expect(row.rows[0]?.domain).toBe('light');
    expect(row.rows[0]?.entity_id).toBe('light.kitchen');
    expect(row.rows[0]?.collector_instance).toBe('collector-test');
  });
});
