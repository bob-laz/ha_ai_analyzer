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
  if (typeof data.entity_id === 'string') {
    return data.entity_id;
  }

  const newState = data.new_state;
  if (newState && typeof newState === 'object' && typeof (newState as { entity_id?: unknown }).entity_id === 'string') {
    return (newState as { entity_id: string }).entity_id;
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
