import type { HARawMessage, NormalizedEvent } from './types.js';

export type NormalizeOptions = {
  resolveEntityFromDeviceIds?: (deviceIds: string[]) => string | null;
};

const parseDate = (raw: string | undefined): Date => {
  if (!raw) {
    return new Date();
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) {
    return new Date();
  }

  return parsed;
};

const extractEntityId = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
};

const extractStringValues = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      values.push(trimmed);
    }
  }
  return values;
};

export const extractTargetDeviceIds = (data: Record<string, unknown>): string[] => {
  const unique = new Set<string>();

  const addFrom = (candidate: unknown): void => {
    for (const value of extractStringValues(candidate)) {
      unique.add(value);
    }
  };

  const serviceData = data.service_data;
  if (serviceData && typeof serviceData === 'object') {
    addFrom((serviceData as { device_id?: unknown }).device_id);
  }

  const target = data.target;
  if (target && typeof target === 'object') {
    addFrom((target as { device_id?: unknown }).device_id);
  }

  return [...unique];
};

const resolveEntityId = (data: Record<string, unknown>): string | null => {
  const directEntityId = extractEntityId(data.entity_id);
  if (directEntityId) {
    return directEntityId;
  }

  const newState = data.new_state;
  if (newState && typeof newState === 'object') {
    const newStateEntityId = extractEntityId((newState as { entity_id?: unknown }).entity_id);
    if (newStateEntityId) {
      return newStateEntityId;
    }
  }

  const serviceData = data.service_data;
  if (serviceData && typeof serviceData === 'object') {
    const serviceEntityId = extractEntityId((serviceData as { entity_id?: unknown }).entity_id);
    if (serviceEntityId) {
      return serviceEntityId;
    }
  }

  const target = data.target;
  if (target && typeof target === 'object') {
    const targetEntityId = extractEntityId((target as { entity_id?: unknown }).entity_id);
    if (targetEntityId) {
      return targetEntityId;
    }
  }

  return null;
};

export const extractDomain = (
  eventType: string,
  data: Record<string, unknown>,
  entityId: string | null,
): string | null => {
  if (eventType === 'call_service' && typeof data.domain === 'string') {
    return data.domain;
  }

  if (!entityId || !entityId.includes('.')) {
    return null;
  }

  return entityId.split('.', 1)[0] ?? null;
};

export const normalizeEvent = (message: HARawMessage, options: NormalizeOptions = {}): NormalizedEvent => {
  const eventPayload = message.event ?? {};
  const eventType = typeof eventPayload.event_type === 'string' ? eventPayload.event_type : 'unknown';
  const eventData = (eventPayload.data ?? {}) as Record<string, unknown>;

  let entityId = resolveEntityId(eventData);
  if (!entityId && eventType === 'call_service' && options.resolveEntityFromDeviceIds) {
    const deviceIds = extractTargetDeviceIds(eventData);
    if (deviceIds.length > 0) {
      entityId = options.resolveEntityFromDeviceIds(deviceIds);
    }
  }
  const service = eventType === 'call_service' && typeof eventData.service === 'string' ? eventData.service : null;

  return {
    eventType,
    eventTime: parseDate(eventPayload.time_fired),
    domain: extractDomain(eventType, eventData, entityId),
    entityId,
    service,
    contextId: eventPayload.context?.id ?? null,
    parentContextId: eventPayload.context?.parent_id ?? null,
    userId: eventPayload.context?.user_id ?? null,
    data: {
      event_type: eventPayload.event_type ?? null,
      time_fired: eventPayload.time_fired ?? null,
      context: eventPayload.context ?? null,
      data: eventData,
    },
    receivedAt: new Date(),
  };
};
