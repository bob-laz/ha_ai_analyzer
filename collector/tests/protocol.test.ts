import net from 'node:net';
import { describe, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import type { CollectorConfig } from '../src/config.js';
import { HAEventCollector } from '../src/haClient.js';
import type { NormalizedEvent } from '../src/types.js';

const createConfig = (haWsUrl: string, eventTypes: string[] = ['state_changed']): CollectorConfig => ({
  databaseUrl: 'postgresql://unused',
  haWsUrl,
  haToken: 'test-token',
  eventTypes,
  domainAllowlist: new Set(),
  domainExcludelist: new Set(),
  batchSize: 5,
  flushIntervalSeconds: 1,
  reconnectInitialSeconds: 0.01,
  reconnectMaxSeconds: 0.05,
  reconnectJitterRatio: 0,
  maxBufferedEvents: 20,
  overflowPolicy: 'drop_newest',
  retryBackpressureDelayMs: 10,
  collectorInstanceId: 'collector-protocol-test',
  logLevel: 'info',
});

const createServer = async (): Promise<{ wss: WebSocketServer; port: number }> => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('unable to resolve websocket server port');
  }
  return { wss, port: address.port };
};

const canBindTcpPort = async (): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const probe = net.createServer();

    probe.once('error', () => {
      resolve(false);
    });

    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });

const closeServer = async (wss: WebSocketServer): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
};

describe('collector websocket protocol', () => {
  test('authenticates and consumes event', async () => {
    if (!(await canBindTcpPort())) {
      return;
    }
    const server = await createServer();
    const { wss, port } = server;

    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'auth_required' }));

      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: number };
        if (message.type === 'auth') {
          socket.send(JSON.stringify({ type: 'auth_ok' }));
          return;
        }

        if (message.type === 'subscribe_events') {
          socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
          socket.send(
            JSON.stringify({
              type: 'event',
              id: message.id,
              event: {
                event_type: 'state_changed',
                time_fired: '2026-01-02T00:00:00.000Z',
                context: { id: 'ctx-auth' },
                data: { entity_id: 'sensor.office_temperature', new_state: { entity_id: 'sensor.office_temperature' } },
              },
            }),
          );
        }
      });
    });

    const writer = {
      add: vi.fn(async (_event: NormalizedEvent) => true),
    };

    const collector = new HAEventCollector(createConfig(`ws://127.0.0.1:${port}`), writer);
    writer.add.mockImplementation(async () => {
      collector.stop();
      return true;
    });

    await collector.runForever();

    expect(writer.add).toHaveBeenCalledTimes(1);
    const firstEvent = writer.add.mock.calls[0]?.[0] as NormalizedEvent | undefined;
    expect(firstEvent?.entityId).toBe('sensor.office_temperature');

    await closeServer(wss);
  }, 15_000);

  test('handles out-of-order subscribe acknowledgements by id', async () => {
    if (!(await canBindTcpPort())) {
      return;
    }
    const server = await createServer();
    const { wss, port } = server;

    wss.on('connection', (socket) => {
      let subscribeIds: number[] = [];
      socket.send(JSON.stringify({ type: 'auth_required' }));

      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: number };
        if (message.type === 'auth') {
          socket.send(JSON.stringify({ type: 'auth_ok' }));
          return;
        }

        if (message.type === 'subscribe_events' && typeof message.id === 'number') {
          subscribeIds.push(message.id);
          if (subscribeIds.length === 2) {
            subscribeIds = subscribeIds.sort((a, b) => a - b);
            socket.send(JSON.stringify({ id: subscribeIds[1], type: 'result', success: true, result: null }));
            socket.send(JSON.stringify({ id: subscribeIds[0], type: 'result', success: true, result: null }));
            socket.send(
              JSON.stringify({
                type: 'event',
                event: {
                  event_type: 'call_service',
                  time_fired: '2026-01-02T00:01:00.000Z',
                  context: { id: 'ctx-ack' },
                  data: { domain: 'light', service: 'turn_on' },
                },
              }),
            );
          }
        }
      });
    });

    const writer = {
      add: vi.fn(async (_event: NormalizedEvent) => true),
    };

    const collector = new HAEventCollector(
      createConfig(`ws://127.0.0.1:${port}`, ['state_changed', 'call_service']),
      writer,
    );
    writer.add.mockImplementation(async () => {
      collector.stop();
      return true;
    });

    await collector.runForever();

    expect(writer.add).toHaveBeenCalledTimes(1);
    const firstEvent = writer.add.mock.calls[0]?.[0] as NormalizedEvent | undefined;
    expect(firstEvent?.service).toBe('turn_on');

    await closeServer(wss);
  }, 15_000);

  test('reconnects after dropped connection and resumes ingest', async () => {
    if (!(await canBindTcpPort())) {
      return;
    }
    const server = await createServer();
    const { wss, port } = server;
    let connectionCount = 0;

    wss.on('connection', (socket) => {
      connectionCount += 1;
      socket.send(JSON.stringify({ type: 'auth_required' }));

      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: number };
        if (message.type === 'auth') {
          socket.send(JSON.stringify({ type: 'auth_ok' }));
          return;
        }

        if (message.type === 'subscribe_events') {
          socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));

          if (connectionCount === 1) {
            socket.close();
          } else {
            socket.send(
              JSON.stringify({
                type: 'event',
                event: {
                  event_type: 'state_changed',
                  time_fired: '2026-01-02T00:02:00.000Z',
                  context: { id: 'ctx-reconnect' },
                  data: { entity_id: 'switch.garage', new_state: { entity_id: 'switch.garage' } },
                },
              }),
            );
          }
        }
      });
    });

    const writer = {
      add: vi.fn(async (_event: NormalizedEvent) => true),
    };

    const collector = new HAEventCollector(createConfig(`ws://127.0.0.1:${port}`), writer);
    writer.add.mockImplementation(async () => {
      collector.stop();
      return true;
    });

    await collector.runForever();

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(writer.add).toHaveBeenCalledTimes(1);

    await closeServer(wss);
  }, 20_000);
});
