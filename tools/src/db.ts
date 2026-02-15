import { Pool, type QueryResultRow } from 'pg';

export type SqlQueryResult<T extends QueryResultRow> = {
  rows: T[];
  rowCount: number | null;
};

export type SqlQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
};

export const createToolsPool = (databaseUrl: string): Pool =>
  new Pool({
    connectionString: databaseUrl,
    max: 8,
  });
