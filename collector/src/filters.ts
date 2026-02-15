import type { NormalizedEvent } from './types.js';

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const extractStateValue = (statePayload: unknown): string | null => {
  const stateRecord = asRecord(statePayload);
  if (!stateRecord) {
    return null;
  }

  const state = stateRecord.state;
  return typeof state === 'string' ? state : null;
};

const extractDeviceClass = (statePayload: unknown): string | null => {
  const stateRecord = asRecord(statePayload);
  if (!stateRecord) {
    return null;
  }

  const attributes = asRecord(stateRecord.attributes);
  if (!attributes) {
    return null;
  }

  const deviceClass = attributes.device_class;
  return typeof deviceClass === 'string' ? deviceClass : null;
};

const extractStateChange = (
  event: NormalizedEvent,
): {
  oldState: string | null;
  newState: string | null;
  oldDeviceClass: string | null;
  newDeviceClass: string | null;
} => {
  const payload = asRecord(event.data);
  const eventData = asRecord(payload?.data);
  const oldStatePayload = eventData?.old_state;
  const newStatePayload = eventData?.new_state;

  return {
    oldState: extractStateValue(oldStatePayload),
    newState: extractStateValue(newStatePayload),
    oldDeviceClass: extractDeviceClass(oldStatePayload),
    newDeviceClass: extractDeviceClass(newStatePayload),
  };
};

export const isAllowed = (event: NormalizedEvent, allowlist: Set<string>, excludelist: Set<string>): boolean => {
  if (event.domain && excludelist.has(event.domain)) {
    return false;
  }

  if (allowlist.size > 0 && (!event.domain || !allowlist.has(event.domain))) {
    return false;
  }

  if (event.eventType === 'state_changed') {
    const { oldState, newState, oldDeviceClass, newDeviceClass } = extractStateChange(event);

    if (oldState !== null && newState !== null && oldState === newState) {
      return false;
    }

    if (event.domain === 'binary_sensor' && (oldDeviceClass === 'motion' || newDeviceClass === 'motion')) {
      return oldState === 'off' && newState === 'on';
    }
  }

  return true;
};
