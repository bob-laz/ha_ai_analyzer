import { type RawData, WebSocket } from 'ws';

import type { CollectorConfig } from './config.js';
import { BufferOverflowError } from './db.js';
import { isAllowed } from './filters.js';
import { extractTargetDeviceIds, normalizeEvent } from './normalize.js';
import type { EventWriter, HARawMessage } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
};

class MessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: (item: T) => void; reject: (error: Error) => void }> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  next(): Promise<T> {
    const existing = this.items.shift();
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  failAll(error: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }
}

class MessageRouter {
  private readonly controlQueue = new MessageQueue<HARawMessage>();
  private readonly eventQueue = new MessageQueue<HARawMessage>();
  private readonly pendingResults = new Map<
    number,
    { resolve: (msg: HARawMessage) => void; reject: (error: Error) => void }
  >();
  private closedError: Error | null = null;

  constructor(private readonly ws: WebSocket) {
    this.ws.on('message', this.handleMessage);
    this.ws.on('error', this.handleFailure);
    this.ws.on('close', this.handleClosed);
  }

  shutdown(): void {
    this.ws.off('message', this.handleMessage);
    this.ws.off('error', this.handleFailure);
    this.ws.off('close', this.handleClosed);
    this.failAll(new Error('router shut down'));
  }

  async waitForControlType(type: string, timeoutMs: number): Promise<HARawMessage> {
    const timeoutAt = Date.now() + timeoutMs;
    while (true) {
      const remainingMs = timeoutAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`timed out waiting for ${type}`);
      }

      const message = await withTimeout(this.controlQueue.next(), remainingMs, type);
      if (message.type === type) {
        return message;
      }

      if (message.type === 'event') {
        this.eventQueue.push(message);
      }
    }
  }

  async waitForResult(id: number, timeoutMs: number): Promise<HARawMessage> {
    if (this.closedError) {
      throw this.closedError;
    }

    return await new Promise<HARawMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingResults.delete(id);
        reject(new Error(`timed out waiting for result:${id}`));
      }, timeoutMs);

      this.pendingResults.set(id, {
        resolve: (message) => {
          clearTimeout(timeoutId);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async nextEvent(): Promise<HARawMessage> {
    if (this.closedError) {
      throw this.closedError;
    }
    return await this.eventQueue.next();
  }

  private handleClosed = (): void => {
    this.failAll(new Error('websocket closed'));
  };

  private handleFailure = (error: Error): void => {
    this.failAll(error);
  };

  private failAll(error: Error): void {
    this.closedError = error;
    this.controlQueue.failAll(error);
    this.eventQueue.failAll(error);

    for (const [resultId, pending] of this.pendingResults.entries()) {
      pending.reject(error);
      this.pendingResults.delete(resultId);
    }
  }

  private handleMessage = (rawMessage: RawData): void => {
    const rawText = toText(rawMessage);
    let parsed: HARawMessage;

    try {
      parsed = JSON.parse(rawText) as HARawMessage;
    } catch (error) {
      console.error('quarantined malformed websocket message', {
        error: error instanceof Error ? error.message : String(error),
        payload: rawText.slice(0, 800),
      });
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.error('quarantined invalid websocket message shape', {
        payload: rawText.slice(0, 800),
      });
      return;
    }

    if (parsed.type === 'pong' || parsed.type === 'ping') {
      return;
    }

    if (parsed.type === 'event') {
      this.eventQueue.push(parsed);
      return;
    }

    if (parsed.type === 'result' && typeof parsed.id === 'number') {
      const pending = this.pendingResults.get(parsed.id);
      if (pending) {
        this.pendingResults.delete(parsed.id);
        pending.resolve(parsed);
      } else {
        this.controlQueue.push(parsed);
      }
      return;
    }

    this.controlQueue.push(parsed);
  };
}

const toText = (message: RawData): string => {
  if (typeof message === 'string') {
    return message;
  }

  if (Buffer.isBuffer(message)) {
    return message.toString('utf8');
  }

  if (Array.isArray(message)) {
    return Buffer.concat(message).toString('utf8');
  }

  return Buffer.from(message).toString('utf8');
};

export class HAEventCollector {
  private running = true;
  private nextMessageId = 1;
  private activeSocket: WebSocket | null = null;
  private hasAttemptedEntityRegistryLoad = false;
  private readonly entityIdsByDeviceId = new Map<string, string[]>();

  constructor(
    private readonly config: CollectorConfig,
    private readonly writer: EventWriter,
  ) {}

  stop(): void {
    this.running = false;
    if (this.activeSocket) {
      this.activeSocket.close();
    }
  }

  async runForever(): Promise<void> {
    let backoffMs = this.config.reconnectInitialSeconds * 1000;
    const maxBackoffMs = this.config.reconnectMaxSeconds * 1000;

    while (this.running) {
      try {
        await this.runOnce();
        backoffMs = this.config.reconnectInitialSeconds * 1000;
      } catch (error) {
        if (!this.running) {
          break;
        }

        const jitter = backoffMs * this.config.reconnectJitterRatio;
        const sleepMs = Math.max(25, Math.floor(backoffMs + (Math.random() * 2 - 1) * jitter));

        console.error('collector connection dropped', {
          error: error instanceof Error ? error.message : String(error),
          reconnectInMs: sleepMs,
        });

        await sleep(sleepMs);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }
    }
  }

  async runOnce(): Promise<void> {
    const ws = new WebSocket(this.config.haWsUrl);
    this.activeSocket = ws;

    const router = new MessageRouter(ws);
    await this.waitForOpen(ws);

    try {
      await this.authenticate(ws, router);
      await this.subscribe(ws, router);
      await this.consume(ws, router);
    } finally {
      router.shutdown();
      this.activeSocket = null;
      ws.close();
    }
  }

  private async waitForOpen(ws: WebSocket): Promise<void> {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (error) => reject(error));
      }),
      10000,
      'websocket open',
    );
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    ws.send(JSON.stringify(payload));
  }

  private nextId(): number {
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    return id;
  }

  private async authenticate(ws: WebSocket, router: MessageRouter): Promise<void> {
    const authRequired = await router.waitForControlType('auth_required', 15000);
    if (authRequired.type !== 'auth_required') {
      throw new Error(`expected auth_required, received ${authRequired.type ?? 'unknown'}`);
    }

    this.sendJson(ws, { type: 'auth', access_token: this.config.haToken });
    const authResult = await router.waitForControlType('auth_ok', 15000);
    if (authResult.type !== 'auth_ok') {
      throw new Error(`authentication failed: ${JSON.stringify(authResult)}`);
    }
  }

  private async subscribe(ws: WebSocket, router: MessageRouter): Promise<void> {
    const pendingResults: Promise<HARawMessage>[] = [];

    for (const eventType of this.config.eventTypes) {
      const id = this.nextId();
      this.sendJson(ws, {
        id,
        type: 'subscribe_events',
        event_type: eventType,
      });
      pendingResults.push(router.waitForResult(id, 15000));
    }

    const results = await Promise.all(pendingResults);
    for (const result of results) {
      if (result.type !== 'result' || result.success !== true) {
        throw new Error(`subscription failed: ${JSON.stringify(result)}`);
      }
    }
  }

  private resolveEntityFromDeviceIds = (deviceIds: string[]): string | null => {
    for (const deviceId of deviceIds) {
      const mappedEntityIds = this.entityIdsByDeviceId.get(deviceId);
      if (!mappedEntityIds || mappedEntityIds.length === 0) {
        continue;
      }
      const first = mappedEntityIds[0];
      if (first && first.trim().length > 0) {
        return first;
      }
    }
    return null;
  };

  private async loadEntityRegistry(ws: WebSocket, router: MessageRouter): Promise<void> {
    if (this.hasAttemptedEntityRegistryLoad) {
      return;
    }
    this.hasAttemptedEntityRegistryLoad = true;

    const id = this.nextId();
    this.sendJson(ws, { id, type: 'config/entity_registry/list' });

    try {
      const result = await router.waitForResult(id, 3000);
      if (result.type !== 'result' || result.success !== true || !Array.isArray(result.result)) {
        console.warn('entity registry lookup unavailable; continuing without device_id enrichment');
        return;
      }

      for (const entry of result.result) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const entityId = (entry as { entity_id?: unknown }).entity_id;
        const deviceId = (entry as { device_id?: unknown }).device_id;
        if (typeof entityId !== 'string' || typeof deviceId !== 'string') {
          continue;
        }

        const existing = this.entityIdsByDeviceId.get(deviceId);
        if (existing) {
          if (!existing.includes(entityId)) {
            existing.push(entityId);
          }
          continue;
        }
        this.entityIdsByDeviceId.set(deviceId, [entityId]);
      }
    } catch (error) {
      console.warn('entity registry lookup timed out; continuing without device_id enrichment', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async consume(ws: WebSocket, router: MessageRouter): Promise<void> {
    while (this.running) {
      const message = await router.nextEvent();
      if (message.type !== 'event' || !message.event) {
        continue;
      }

      let normalized = normalizeEvent(message, {
        resolveEntityFromDeviceIds: this.resolveEntityFromDeviceIds,
      });

      if (normalized.eventType === 'call_service' && normalized.entityId === null) {
        const eventData = (message.event.data ?? {}) as Record<string, unknown>;
        const deviceIds = extractTargetDeviceIds(eventData);
        if (deviceIds.length > 0) {
          await this.loadEntityRegistry(ws, router);
          normalized = normalizeEvent(message, {
            resolveEntityFromDeviceIds: this.resolveEntityFromDeviceIds,
          });
        }
      }

      if (!isAllowed(normalized, this.config.domainAllowlist, this.config.domainExcludelist)) {
        continue;
      }

      try {
        const accepted = await this.writer.add(normalized);
        if (!accepted) {
          console.warn('event dropped due to backpressure policy', {
            entityId: normalized.entityId,
            eventType: normalized.eventType,
            contextId: normalized.contextId,
          });
        }
      } catch (error) {
        if (error instanceof BufferOverflowError && this.config.overflowPolicy === 'retry') {
          await sleep(this.config.retryBackpressureDelayMs);
          const acceptedOnRetry = await this.writer.add(normalized);
          if (!acceptedOnRetry) {
            console.warn('event dropped after retry attempt', {
              entityId: normalized.entityId,
              eventType: normalized.eventType,
              contextId: normalized.contextId,
            });
          }
          continue;
        }

        throw error;
      }
    }
  }
}
