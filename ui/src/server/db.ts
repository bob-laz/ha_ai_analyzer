import { Pool, type QueryResult } from 'pg';

export type SqlParams = ReadonlyArray<unknown>;

export type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<QueryResult<T>>;
};

export const createUiPool = (connectionString: string): Pool => {
  return new Pool({ connectionString });
};
