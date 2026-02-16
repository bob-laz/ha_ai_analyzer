import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ActionOperation, OperationKind, OperationStatus } from '../shared/types.js';

export type JobResult = {
  exitCode: number;
  output: string;
};

export type JobExecutor = (kind: OperationKind) => Promise<JobResult>;

export type ActionRunner = {
  start(kind: OperationKind): ActionOperation;
  get(operationId: string): ActionOperation | null;
  stop(): void;
};

type ActionRunnerConfig = {
  ttlSeconds: number;
  workspaceRoot: string;
  yarnBin: string;
  maxOutputChars?: number;
  executor?: JobExecutor;
};

const OPERATION_ARGS: Record<OperationKind, string[]> = {
  'run-analysis': ['workspace', '@ha-ai/tools', 'start:analytics', '--once'],
  'run-daily-summary': ['workspace', '@ha-ai/tools', 'start:daily-home-summary', '--once'],
  'run-automation-snapshots': ['workspace', '@ha-ai/tools', 'start:automation-snapshots', '--once'],
  'run-retention': ['workspace', '@ha-ai/tools', 'start:retention', '--once'],
};

const TERMINAL_STATES = new Set<OperationStatus>(['completed', 'failed']);

const trimOutput = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = '\n...[truncated]';
  const keepChars = Math.max(0, maxChars - suffix.length);
  return `${value.slice(0, keepChars)}${suffix}`;
};

const cloneOperation = (operation: ActionOperation): ActionOperation => {
  return { ...operation };
};

export const createDefaultJobExecutor = (config: {
  workspaceRoot: string;
  yarnBin: string;
  maxOutputChars: number;
}): JobExecutor => {
  return async (kind) => {
    const args = OPERATION_ARGS[kind];

    return new Promise<JobResult>((resolve, reject) => {
      const child = spawn(config.yarnBin, args, {
        cwd: config.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let combinedOutput = '';
      const appendOutput = (chunk: Buffer): void => {
        combinedOutput = trimOutput(`${combinedOutput}${chunk.toString('utf8')}`, config.maxOutputChars);
      };

      child.stdout.on('data', appendOutput);
      child.stderr.on('data', appendOutput);
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          output: combinedOutput,
        });
      });
    });
  };
};

export const createActionRunner = (config: ActionRunnerConfig): ActionRunner => {
  const ttlMs = config.ttlSeconds * 1000;
  const maxOutputChars = config.maxOutputChars ?? 5000;
  const executor =
    config.executor ??
    createDefaultJobExecutor({
      workspaceRoot: config.workspaceRoot,
      yarnBin: config.yarnBin,
      maxOutputChars,
    });

  const operations = new Map<string, ActionOperation>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, operation] of operations.entries()) {
      if (!TERMINAL_STATES.has(operation.status)) {
        continue;
      }

      const ageMs = now - new Date(operation.updatedAt).getTime();
      if (ageMs >= ttlMs) {
        operations.delete(id);
      }
    }
  }, 60_000);
  cleanupTimer.unref();

  const updateOperation = (
    operationId: string,
    patch: Partial<
      Pick<ActionOperation, 'status' | 'message' | 'completedAt' | 'exitCode' | 'outputPreview' | 'updatedAt'>
    >,
  ): void => {
    const existing = operations.get(operationId);
    if (!existing) {
      return;
    }

    operations.set(operationId, {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    });
  };

  return {
    start(kind) {
      const now = new Date().toISOString();
      const operation: ActionOperation = {
        id: randomUUID(),
        kind,
        status: 'queued',
        message: 'Queued',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        exitCode: null,
        outputPreview: null,
      };

      operations.set(operation.id, operation);

      void (async () => {
        updateOperation(operation.id, { status: 'running', message: 'Running' });

        try {
          const result = await executor(kind);
          const completedAt = new Date().toISOString();
          if (result.exitCode === 0) {
            updateOperation(operation.id, {
              status: 'completed',
              message: 'Completed successfully',
              completedAt,
              exitCode: 0,
              outputPreview: result.output ? trimOutput(result.output, maxOutputChars) : null,
            });
            return;
          }

          updateOperation(operation.id, {
            status: 'failed',
            message: `Failed with exit code ${result.exitCode}`,
            completedAt,
            exitCode: result.exitCode,
            outputPreview: result.output ? trimOutput(result.output, maxOutputChars) : null,
          });
        } catch (error) {
          const completedAt = new Date().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          updateOperation(operation.id, {
            status: 'failed',
            message,
            completedAt,
            exitCode: 1,
            outputPreview: message,
          });
        }
      })();

      return cloneOperation(operation);
    },

    get(operationId) {
      const operation = operations.get(operationId);
      return operation ? cloneOperation(operation) : null;
    },

    stop() {
      clearInterval(cleanupTimer);
      operations.clear();
    },
  };
};
