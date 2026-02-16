import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type UiConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  basicAuthUsername: string;
  basicAuthPassword: string;
  actionStatusTtlSeconds: number;
  defaultPollIntervalMs: number;
  buildVersion: string;
  webDistDir: string;
  workspaceRoot: string;
  yarnBin: string;
};

const thisDir = dirname(fileURLToPath(import.meta.url));

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
};

const requiredString = (raw: string | undefined, key: string): string => {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
};

export const loadUiConfig = (env: NodeJS.ProcessEnv = process.env): UiConfig => {
  return {
    host: env.UI_HOST?.trim() || '0.0.0.0',
    port: parsePositiveInt(env.UI_PORT, 5080),
    databaseUrl: requiredString(env.DATABASE_URL, 'DATABASE_URL'),
    basicAuthUsername: requiredString(env.UI_BASIC_AUTH_USERNAME, 'UI_BASIC_AUTH_USERNAME'),
    basicAuthPassword: requiredString(env.UI_BASIC_AUTH_PASSWORD, 'UI_BASIC_AUTH_PASSWORD'),
    actionStatusTtlSeconds: parsePositiveInt(env.UI_ACTION_STATUS_TTL_SECONDS, 900),
    defaultPollIntervalMs: parsePositiveInt(env.UI_DEFAULT_POLL_INTERVAL_MS, 10_000),
    buildVersion: env.UI_BUILD_VERSION?.trim() || 'dev',
    webDistDir: env.UI_WEB_DIST_DIR?.trim() || resolve(thisDir, '../../dist/web'),
    workspaceRoot: env.UI_WORKSPACE_ROOT?.trim() || process.cwd(),
    yarnBin: env.UI_YARN_BIN?.trim() || 'yarn',
  };
};
