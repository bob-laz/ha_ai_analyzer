import { describe, expect, test } from 'vitest';

import { extractTargetDeviceIds, normalizeEvent } from '../src/normalize.js';
import type { HARawMessage } from '../src/types.js';

const callServiceMessage = (data: Record<string, unknown>): HARawMessage => ({
  type: 'event',
  event: {
    event_type: 'call_service',
    time_fired: '2026-01-02T00:00:00.000Z',
    context: { id: 'ctx-1' },
    data,
  },
});

describe('normalize event device_id enrichment', () => {
  test('extracts device_ids from service_data and target', () => {
    const ids = extractTargetDeviceIds({
      service_data: { device_id: ['dev-a', 'dev-b'] },
      target: { device_id: 'dev-c' },
    });
    expect(ids).toEqual(['dev-a', 'dev-b', 'dev-c']);
  });

  test('resolves entity_id from mapped service_data.device_id', () => {
    const normalized = normalizeEvent(
      callServiceMessage({
        domain: 'light',
        service: 'turn_off',
        service_data: { device_id: 'device-123' },
      }),
      {
        resolveEntityFromDeviceIds: (deviceIds) => {
          if (deviceIds.includes('device-123')) {
            return 'light.kitchen';
          }
          return null;
        },
      },
    );

    expect(normalized.entityId).toBe('light.kitchen');
    expect(normalized.domain).toBe('light');
  });

  test('keeps entity_id null when no mapping is available', () => {
    const normalized = normalizeEvent(callServiceMessage({ domain: 'light', service_data: { device_id: 'dev-miss' } }));
    expect(normalized.entityId).toBeNull();
  });
});
