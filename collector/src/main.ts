import { loadConfig } from './config.js';
import { BatchedEventWriter, createPool } from './db.js';
import { HAEventCollector } from './haClient.js';

const main = async (): Promise<void> => {
  const config = loadConfig();
  if (!config.haToken) {
    throw new Error('HA_TOKEN is required');
  }

  const allowlist = [...config.domainAllowlist].sort();
  const excludelist = [...config.domainExcludelist].sort();
  console.info('collector filter configuration', {
    eventTypes: config.eventTypes,
    domainAllowlist: allowlist,
    domainExcludelist: excludelist,
  });
  if (allowlist.length === 0) {
    console.warn('collector allowlist is empty; all domains will be collected unless excluded');
  }

  const pool = createPool(config.databaseUrl);
  const writer = new BatchedEventWriter(
    pool,
    config.collectorInstanceId,
    config.batchSize,
    config.flushIntervalSeconds * 1000,
    config.maxBufferedEvents,
    config.overflowPolicy,
  );

  const collector = new HAEventCollector(config, writer);
  let shutdownStarted = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    console.info('collector shutdown requested', { signal });
    collector.stop();
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  writer.start();

  try {
    await collector.runForever();
  } finally {
    await writer.stop();
    const writerStats = writer.getStats();
    console.info('collector writer stats', writerStats);
    await pool.end();
  }
};

void main().catch((error) => {
  console.error('collector crashed', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
