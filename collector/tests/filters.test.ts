import { describe, expect, test } from 'vitest';

import { isAllowed } from '../src/filters.js';
import type { NormalizedEvent } from '../src/types.js';

const baseEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  eventType: 'state_changed',
  eventTime: new Date('2026-01-01T00:00:00.000Z'),
  domain: 'binary_sensor',
  entityId: 'binary_sensor.driveway_motion',
  service: null,
  contextId: 'ctx-1',
  parentContextId: null,
  userId: null,
  data: {},
  receivedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const stateChangedPayload = (
  oldState: string | null,
  newState: string | null,
  deviceClass: string | null = null,
): Record<string, unknown> => ({
  data: {
    old_state:
      oldState === null
        ? null
        : {
            state: oldState,
            attributes: deviceClass ? { device_class: deviceClass } : {},
          },
    new_state:
      newState === null
        ? null
        : {
            state: newState,
            attributes: deviceClass ? { device_class: deviceClass } : {},
          },
  },
});

describe('isAllowed', () => {
  test('drops state_changed events where old and new state are equal', () => {
    const event = baseEvent({
      domain: 'climate',
      entityId: 'climate.upstairs_thermostat',
      data: stateChangedPayload('heat_cool', 'heat_cool'),
    });

    expect(isAllowed(event, new Set(), new Set())).toBe(false);
  });

  test('keeps state_changed events where old and new state differ for non-motion entities', () => {
    const event = baseEvent({
      domain: 'climate',
      entityId: 'climate.upstairs_thermostat',
      data: stateChangedPayload('cool', 'heat_cool'),
    });

    expect(isAllowed(event, new Set(), new Set())).toBe(true);
  });

  test('keeps binary_sensor motion events for off->on transitions', () => {
    const event = baseEvent({
      data: stateChangedPayload('off', 'on', 'motion'),
    });

    expect(isAllowed(event, new Set(), new Set())).toBe(true);
  });

  test('drops binary_sensor motion events for on->off transitions', () => {
    const event = baseEvent({
      data: stateChangedPayload('on', 'off', 'motion'),
    });

    expect(isAllowed(event, new Set(), new Set())).toBe(false);
  });

  test('does not enforce motion transition rule on non-motion binary sensors', () => {
    const event = baseEvent({
      entityId: 'binary_sensor.front_door',
      data: stateChangedPayload('on', 'off', 'door'),
    });

    expect(isAllowed(event, new Set(), new Set())).toBe(true);
  });

  test('still enforces domain excludelist', () => {
    const event = baseEvent({
      domain: 'binary_sensor',
      data: stateChangedPayload('off', 'on', 'motion'),
    });

    expect(isAllowed(event, new Set(), new Set(['binary_sensor']))).toBe(false);
  });

  test('still enforces domain allowlist', () => {
    const event = baseEvent({
      domain: 'light',
      entityId: 'light.kitchen',
      data: stateChangedPayload('off', 'on'),
    });

    expect(isAllowed(event, new Set(['binary_sensor']), new Set())).toBe(false);
  });

  test('matches allowlist/excludelist case-insensitively against event domain', () => {
    const event = baseEvent({
      domain: 'Light',
      entityId: 'light.kitchen',
      data: stateChangedPayload('off', 'on'),
    });

    expect(isAllowed(event, new Set(['light']), new Set())).toBe(true);
    expect(isAllowed(event, new Set(), new Set(['light']))).toBe(false);
  });

  test('applies same-state drop even when domain is allowlisted', () => {
    const event = baseEvent({
      domain: 'climate',
      entityId: 'climate.upstairs_thermostat',
      data: stateChangedPayload('cool', 'cool'),
    });

    expect(isAllowed(event, new Set(['climate']), new Set())).toBe(false);
  });
});
