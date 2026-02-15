import type { HARawMessage, NormalizedEvent } from './types.js';

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

const resolveEntityId = (data: Record<string, unknown>): string | null => {
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

export const normalizeEvent = (message: HARawMessage): NormalizedEvent => {
  const eventPayload = message.event ?? {};
  const eventType = typeof eventPayload.event_type === 'string' ? eventPayload.event_type : 'unknown';
  const eventData = (eventPayload.data ?? {}) as Record<string, unknown>;

  const entityId = resolveEntityId(eventData);
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
