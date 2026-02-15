import { describe, expect, test, vi } from 'vitest';

import { BatchedEventWriter, BufferOverflowError } from '../src/db.js';
import type { NormalizedEvent } from '../src/types.js';

const sampleEvent = (suffix: string): NormalizedEvent => ({
  eventType: 'state_changed',
  eventTime: new Date(`2026-01-01T00:00:0${suffix}.000Z`),
  domain: 'light',
  entityId: `light.kitchen_${suffix}`,
  service: null,
  contextId: `ctx-${suffix}`,
  parentContextId: null,
  userId: 'user-1',
  data: { entity_id: `light.kitchen_${suffix}` },
  receivedAt: new Date(`2026-01-01T00:00:0${suffix}.100Z`),
});

const buildPoolMock = (queryImpl?: (sql: string, params?: unknown[]) => Promise<unknown>) => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (queryImpl) {
      return await queryImpl(sql, params);
    }

    if (sql.includes('INSERT INTO events')) {
      return { rowCount: 2 };
    }

    return { rowCount: 0 };
  });

  const release = vi.fn();

  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  };

  return { pool, query, release };
};

describe('BatchedEventWriter', () => {
  test('flushes a batch when batch size is reached', async () => {
    const { pool, query } = buildPoolMock();
    const writer = new BatchedEventWriter(pool, 'collector-test', 2, 60_000, 20, 'drop_newest');

    await writer.add(sampleEvent('1'));
    await writer.add(sampleEvent('2'));

    const stats = writer.getStats();

    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.any(Array));
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(stats.acceptedEvents).toBe(2);
    expect(stats.flushedRows).toBe(2);
  });

  test('flushes buffered events on stop', async () => {
    const { pool, query } = buildPoolMock(async (sql) => {
      if (sql.includes('INSERT INTO events')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });

    const writer = new BatchedEventWriter(pool, 'collector-test', 10, 60_000, 20, 'drop_newest');
    await writer.add(sampleEvent('1'));
    await writer.stop();

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), expect.any(Array));
    expect(writer.getStats().flushedRows).toBe(1);
  });

  test('rolls back transaction and rethrows insert failure', async () => {
    const { pool, query } = buildPoolMock(async (sql) => {
      if (sql.includes('INSERT INTO events')) {
        throw new Error('insert failed');
      }
      return { rowCount: 0 };
    });

    const writer = new BatchedEventWriter(pool, 'collector-test', 2, 60_000, 20, 'drop_newest');

    await writer.add(sampleEvent('1'));
    await expect(writer.add(sampleEvent('2'))).rejects.toThrow('insert failed');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('applies configured backpressure policy', async () => {
    const { pool } = buildPoolMock();

    const dropNewestWriter = new BatchedEventWriter(pool, 'collector-test', 10, 60_000, 1, 'drop_newest');
    await dropNewestWriter.add(sampleEvent('1'));
    const accepted = await dropNewestWriter.add(sampleEvent('2'));
    expect(accepted).toBe(false);
    expect(dropNewestWriter.getStats().droppedEvents).toBe(1);

    const retryWriter = new BatchedEventWriter(pool, 'collector-test', 10, 60_000, 1, 'retry');
    await retryWriter.add(sampleEvent('3'));
    await expect(retryWriter.add(sampleEvent('4'))).rejects.toBeInstanceOf(BufferOverflowError);
  });
});
