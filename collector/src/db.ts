import crypto from 'node:crypto';

import { Pool } from 'pg';

import type { OverflowPolicy } from './config.js';
import type { NormalizedEvent } from './types.js';

type DbClient = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(): void;
};

type DbPool = {
  connect(): Promise<DbClient>;
};

const INSERT_COLUMNS = [
  'event_type',
  'event_time',
  'domain',
  'entity_id',
  'service',
  'context_id',
  'parent_context_id',
  'user_id',
  'data',
  'dedupe_key',
  'collector_instance',
  'received_at',
] as const;

type WriterRow = {
  event: NormalizedEvent;
  dedupeKey: string;
};

export class BufferOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferOverflowError';
  }
}

export type WriterStats = {
  acceptedEvents: number;
  droppedEvents: number;
  flushedRows: number;
  dedupedRows: number;
};

export class BatchedEventWriter {
  private readonly buffer: WriterRow[] = [];
  private flushHandle: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private stats: WriterStats = {
    acceptedEvents: 0,
    droppedEvents: 0,
    flushedRows: 0,
    dedupedRows: 0,
  };

  constructor(
    private readonly pool: DbPool,
    private readonly collectorInstanceId: string,
    private readonly batchSize: number,
    private readonly flushIntervalMs: number,
    private readonly maxBufferedEvents: number,
    private readonly overflowPolicy: OverflowPolicy,
  ) {}

  start(): void {
    if (this.flushHandle) {
      return;
    }

    this.flushHandle = setInterval(() => {
      void this.flush().catch((error) => {
        console.error('batched flush failed', {
          error: error instanceof Error ? error.message : String(error),
          bufferedEvents: this.buffer.length,
        });
      });
    }, this.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.flushHandle) {
      clearInterval(this.flushHandle);
      this.flushHandle = null;
    }
    await this.flush();
  }

  getStats(): WriterStats {
    return { ...this.stats };
  }

  async add(event: NormalizedEvent): Promise<boolean> {
    if (this.buffer.length >= this.maxBufferedEvents) {
      if (this.overflowPolicy === 'drop_newest') {
        this.stats.droppedEvents += 1;
        return false;
      }

      if (this.overflowPolicy === 'drop_oldest') {
        this.buffer.shift();
        this.stats.droppedEvents += 1;
      } else {
        throw new BufferOverflowError(`buffer is full (${this.maxBufferedEvents} events)`);
      }
    }

    this.buffer.push({
      event,
      dedupeKey: createDedupeKey(event),
    });
    this.stats.acceptedEvents += 1;

    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }

    return true;
  }

  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);

    const client = await this.pool.connect();
    try {
      const { sql, values } = buildInsert(batch, this.collectorInstanceId);
      await client.query('BEGIN');
      const insertResult = await client.query(sql, values);
      await client.query('COMMIT');

      const insertedRows = Number((insertResult as { rowCount?: number }).rowCount ?? batch.length);
      this.stats.flushedRows += insertedRows;
      this.stats.dedupedRows += Math.max(0, batch.length - insertedRows);
    } catch (error) {
      this.buffer.unshift(...batch);
      try {
        await client.query('ROLLBACK');
      } catch {
        // noop
      }
      throw error;
    } finally {
      client.release();
      this.isFlushing = false;
    }
  }
}

const buildInsert = (rows: WriterRow[], collectorInstanceId: string): { sql: string; values: unknown[] } => {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const base = i * INSERT_COLUMNS.length;

    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}, $${base + 11}, $${base + 12})`,
    );

    values.push(
      row.event.eventType,
      row.event.eventTime.toISOString(),
      row.event.domain,
      row.event.entityId,
      row.event.service,
      row.event.contextId,
      row.event.parentContextId,
      row.event.userId,
      JSON.stringify(row.event.data),
      row.dedupeKey,
      collectorInstanceId,
      row.event.receivedAt.toISOString(),
    );
  }

  const sql = `
    INSERT INTO events (
      ${INSERT_COLUMNS.join(', ')}
    )
    VALUES ${placeholders.join(', ')}
    ON CONFLICT DO NOTHING
  `;

  return { sql, values };
};

const createDedupeKey = (event: NormalizedEvent): string => {
  const digestSource = JSON.stringify({
    eventType: event.eventType,
    eventTime: event.eventTime.toISOString(),
    domain: event.domain,
    entityId: event.entityId,
    service: event.service,
    contextId: event.contextId,
    parentContextId: event.parentContextId,
    userId: event.userId,
    data: event.data,
  });

  return crypto.createHash('sha256').update(digestSource).digest('hex');
};

export const createPool = (databaseUrl: string): Pool =>
  new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
