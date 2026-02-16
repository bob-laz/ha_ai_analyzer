import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { createActionRunner } from '../src/server/actionRunner.js';

const waitForTerminalState = async (
  runner: ReturnType<typeof createActionRunner>,
  operationId: string,
): Promise<'completed' | 'failed'> => {
  for (let i = 0; i < 20; i += 1) {
    const operation = runner.get(operationId);
    if (operation?.status === 'completed' || operation?.status === 'failed') {
      return operation.status;
    }
    await sleep(20);
  }

  throw new Error(`operation ${operationId} did not complete in time`);
};

describe('createActionRunner', () => {
  it('marks operation completed when executor exits successfully', async () => {
    const runner = createActionRunner({
      ttlSeconds: 60,
      workspaceRoot: process.cwd(),
      yarnBin: 'yarn',
      executor: async () => ({
        exitCode: 0,
        output: 'ok',
      }),
    });

    const operation = runner.start('run-analysis');
    expect(operation.status).toBe('queued');

    const terminal = await waitForTerminalState(runner, operation.id);
    expect(terminal).toBe('completed');

    const completed = runner.get(operation.id);
    expect(completed?.exitCode).toBe(0);
    expect(completed?.outputPreview).toContain('ok');

    runner.stop();
  });

  it('marks operation failed when executor exits non-zero', async () => {
    const runner = createActionRunner({
      ttlSeconds: 60,
      workspaceRoot: process.cwd(),
      yarnBin: 'yarn',
      executor: async () => ({
        exitCode: 3,
        output: 'boom',
      }),
    });

    const operation = runner.start('run-retention');
    const terminal = await waitForTerminalState(runner, operation.id);

    expect(terminal).toBe('failed');
    const failed = runner.get(operation.id);
    expect(failed?.message).toContain('exit code 3');

    runner.stop();
  });
});
