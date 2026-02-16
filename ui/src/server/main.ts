import { createActionRunner } from './actionRunner.js';
import { loadUiConfig } from './config.js';
import { createServer } from './createServer.js';
import { createUiPool } from './db.js';

const start = async (): Promise<void> => {
  const config = loadUiConfig();
  const pool = createUiPool(config.databaseUrl);
  const actionRunner = createActionRunner({
    ttlSeconds: config.actionStatusTtlSeconds,
    workspaceRoot: config.workspaceRoot,
    yarnBin: config.yarnBin,
  });

  const app = await createServer({
    config,
    db: pool,
    actionRunner,
  });

  const shutdown = async (signal: string): Promise<void> => {
    try {
      await app.close();
      await pool.end();
      actionRunner.stop();
      console.log(`UI server stopped (${signal})`);
      process.exit(0);
    } catch (error) {
      console.error(`UI server shutdown error (${signal})`, error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

  console.log(`UI server listening on http://${config.host}:${config.port}`);
};

void start().catch((error) => {
  console.error('Failed to start UI server', error);
  process.exit(1);
});
