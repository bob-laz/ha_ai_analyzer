import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerApiBasicAuth } from '../src/server/auth.js';

const authHeader = (username: string, password: string): string => {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
};

describe('registerApiBasicAuth', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it('rejects unauthenticated api requests and allows valid credentials', async () => {
    const app = Fastify();
    apps.push(app);

    registerApiBasicAuth(app, {
      username: 'operator',
      password: 'secret',
    });

    app.get('/api/ping', async () => {
      return { ok: true };
    });

    const unauthorized = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: {
        authorization: authHeader('operator', 'secret'),
      },
    });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ ok: true });
  });

  it('does not require auth on non-api routes', async () => {
    const app = Fastify();
    apps.push(app);

    registerApiBasicAuth(app, {
      username: 'operator',
      password: 'secret',
    });

    app.get('/status', async () => {
      return { ready: true };
    });

    const response = await app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
  });
});
