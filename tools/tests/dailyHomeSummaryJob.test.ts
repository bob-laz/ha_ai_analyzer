import { describe, expect, test } from 'vitest';

import { buildDailySummaryNotificationMessage, detectMetricAnomalies } from '../src/dailyHomeSummaryJob.js';

describe('detectMetricAnomalies', () => {
  test('flags large spikes against baseline', () => {
    const anomalies = detectMetricAnomalies(
      {
        day: '2026-02-15',
        totalEvents: 500,
        uniqueEntities: 20,
        stateChanges: 320,
        serviceCalls: 160,
      },
      [
        { day: '2026-02-14', totalEvents: 100, uniqueEntities: 21, stateChanges: 62, serviceCalls: 38 },
        { day: '2026-02-13', totalEvents: 95, uniqueEntities: 19, stateChanges: 58, serviceCalls: 37 },
        { day: '2026-02-12', totalEvents: 110, uniqueEntities: 20, stateChanges: 63, serviceCalls: 40 },
        { day: '2026-02-11', totalEvents: 105, uniqueEntities: 22, stateChanges: 60, serviceCalls: 39 },
      ],
      {
        minBaselineDays: 3,
        anomalyZscoreThreshold: 2,
        anomalyMinDelta: 25,
      },
    );

    expect(anomalies.some((item) => item.metric === 'totalEvents')).toBe(true);
    expect(anomalies.some((item) => item.metric === 'stateChanges')).toBe(true);
  });

  test('returns no anomalies when baseline is too small', () => {
    const anomalies = detectMetricAnomalies(
      {
        day: '2026-02-15',
        totalEvents: 200,
        uniqueEntities: 12,
        stateChanges: 120,
        serviceCalls: 80,
      },
      [{ day: '2026-02-14', totalEvents: 150, uniqueEntities: 12, stateChanges: 95, serviceCalls: 55 }],
      {
        minBaselineDays: 3,
        anomalyZscoreThreshold: 2,
        anomalyMinDelta: 25,
      },
    );

    expect(anomalies).toEqual([]);
  });
});

describe('buildDailySummaryNotificationMessage', () => {
  test('builds readable markdown with anomalies and top subjects', () => {
    const message = buildDailySummaryNotificationMessage(
      {
        targetDay: '2026-02-15',
        targetSummary: {
          day: '2026-02-15',
          totalEvents: 220,
          uniqueEntities: 15,
          stateChanges: 150,
          serviceCalls: 70,
        },
        anomalies: [
          {
            metric: 'totalEvents',
            value: 220,
            baselineMean: 100,
            baselineStddev: 10,
            delta: 120,
            zScore: 12,
          },
        ],
        topEntities: [{ subjectId: 'light.kitchen', eventCount: 42 }],
        topServices: [{ subjectId: 'light.turn_on', eventCount: 38 }],
        resourceUsageSnapshot: {
          capturedAt: '2026-02-15T01:00:00.000Z',
          countsByType: {
            energy: 2,
            water: 1,
            gas: 1,
            power: 1,
          },
          truncatedByType: {
            energy: 0,
            water: 0,
            gas: 0,
            power: 0,
          },
          itemsByType: {
            energy: [],
            water: [],
            gas: [],
            power: [],
          },
        },
      },
      6_000,
    );

    expect(message).toContain('Daily Home Summary (2026-02-15)');
    expect(message).toContain('totalEvents');
    expect(message).toContain('light.kitchen');
    expect(message).toContain('light.turn_on');
  });
});
