import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const parseBasicAuthHeader = (headerValue: string | undefined): { username: string; password: string } | null => {
  if (!headerValue) {
    return null;
  }

  const [scheme, encoded] = headerValue.split(' ');
  if (!scheme || !encoded || scheme.toLowerCase() !== 'basic') {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const delimiter = decoded.indexOf(':');
    if (delimiter < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, delimiter),
      password: decoded.slice(delimiter + 1),
    };
  } catch {
    return null;
  }
};

const secureCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

const unauthorized = (reply: FastifyReply): FastifyReply => {
  return reply
    .header('WWW-Authenticate', 'Basic realm="ha-ai-operator", charset="UTF-8"')
    .code(401)
    .send({ error: 'Unauthorized' });
};

const requestPath = (request: FastifyRequest): string => {
  return request.routeOptions.url || request.raw.url || request.url;
};

export const registerApiBasicAuth = (
  app: FastifyInstance,
  credentials: { username: string; password: string },
): void => {
  app.addHook('onRequest', (request, reply, done) => {
    const path = requestPath(request);
    if (!path.startsWith('/api/')) {
      done();
      return;
    }

    const parsed = parseBasicAuthHeader(request.headers.authorization);
    if (!parsed) {
      void unauthorized(reply);
      return;
    }

    const usernameMatches = secureCompare(parsed.username, credentials.username);
    const passwordMatches = secureCompare(parsed.password, credentials.password);

    if (!usernameMatches || !passwordMatches) {
      void unauthorized(reply);
      return;
    }

    done();
  });
};
