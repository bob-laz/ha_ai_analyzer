import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDailySummary, publishReport } from './agentTools.js';
import { createToolsPool } from './db.js';

const run = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://ha_ai:ha_ai_dev_password@localhost:5432/ha_ai';
  const outputDir = process.env.REPORT_OUTPUT_DIR ?? '/tmp';
  const timezone = process.env.ANALYTICS_TIMEZONE ?? 'UTC';
  const targetDate = new Date().toISOString().slice(0, 10);

  const pool = createToolsPool(databaseUrl);
  try {
    const summary = await getDailySummary(targetDate, pool, timezone);
    const markdown = [
      `# Daily Summary (${targetDate}, ${timezone})`,
      '',
      `- Total events: ${'totalEvents' in summary ? summary.totalEvents : 0}`,
      `- Unique entities: ${'uniqueEntities' in summary ? summary.uniqueEntities : 0}`,
      `- State changes: ${'stateChanges' in summary ? summary.stateChanges : 0}`,
      `- Service calls: ${'serviceCalls' in summary ? summary.serviceCalls : 0}`,
    ].join('\n');

    const reportPayload = {
      reportType: 'daily_summary',
      targetDate,
      timezone,
      summary,
    };

    await publishReport(markdown, reportPayload, pool);

    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, `daily-summary-${targetDate}.json`),
      JSON.stringify(reportPayload, null, 2),
      'utf8',
    );
  } finally {
    await pool.end();
  }
};

void run().catch((error) => {
  console.error('analytics job failed', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
