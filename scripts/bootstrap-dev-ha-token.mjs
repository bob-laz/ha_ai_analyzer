#!/usr/bin/env node

const httpBase = (process.env.DEV_HA_HTTP_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const wsUrl =
  process.env.DEV_HA_WS_URL ||
  `${httpBase.startsWith('https://') ? 'wss://' : 'ws://'}${httpBase.replace(/^https?:\/\//, '')}/api/websocket`;

const ownerName = process.env.DEV_HA_OWNER_NAME || 'HA AI Dev';
const ownerUsername = process.env.DEV_HA_OWNER_USERNAME || 'ha_ai_dev';
const ownerPassword = process.env.DEV_HA_OWNER_PASSWORD || 'ha_ai_dev_password';
const ownerLanguage = process.env.DEV_HA_OWNER_LANGUAGE || 'en';

const clientId = process.env.DEV_HA_CLIENT_ID || `${httpBase}/`;
const redirectUri = process.env.DEV_HA_REDIRECT_URI || `${httpBase}/auth/external/callback`;
const tokenClientName = process.env.DEV_HA_TOKEN_CLIENT_NAME || 'ha-ai-collector-dev';
const tokenClientNameRun = `${tokenClientName}-${Date.now().toString(36)}`;
const tokenLifespanDays = Number.parseInt(process.env.DEV_HA_TOKEN_LIFESPAN_DAYS || '3650', 10);

if (!Number.isInteger(tokenLifespanDays) || tokenLifespanDays <= 0) {
  console.error('DEV_HA_TOKEN_LIFESPAN_DAYS must be a positive integer.');
  process.exit(1);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function httpJson(path, init = {}, acceptableStatuses = [200]) {
  const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${httpBase}${path}`;
  const response = await fetch(url, init);
  const rawBody = await response.text();

  let json = null;
  if (rawBody.length > 0) {
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = null;
    }
  }

  if (!acceptableStatuses.includes(response.status)) {
    const bodyPreview = rawBody.length > 800 ? `${rawBody.slice(0, 800)}...` : rawBody;
    throw new Error(`HTTP ${response.status} ${url}: ${bodyPreview}`);
  }

  return { status: response.status, json, rawBody };
}

async function getOnboardingStatus() {
  const { json } = await httpJson('/api/onboarding');
  if (!Array.isArray(json)) {
    throw new Error('Unexpected /api/onboarding response shape.');
  }

  const status = {
    user: false,
    core_config: false,
    analytics: false,
    integration: false,
  };

  for (const step of json) {
    if (!isObject(step) || typeof step.step !== 'string') {
      continue;
    }
    if (Object.hasOwn(status, step.step)) {
      status[step.step] = Boolean(step.done);
    }
  }

  return status;
}

async function createOnboardingUserAuthCode() {
  const payload = {
    name: ownerName,
    username: ownerUsername,
    password: ownerPassword,
    client_id: clientId,
    language: ownerLanguage,
  };

  const { json } = await httpJson(
    '/api/onboarding/users',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    [200],
  );

  if (!isObject(json) || typeof json.auth_code !== 'string' || json.auth_code.length === 0) {
    throw new Error('Onboarding user creation did not return auth_code.');
  }

  return json.auth_code;
}

async function createLoginFlowAuthCode() {
  const start = await httpJson(
    '/auth/login_flow',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        handler: ['homeassistant', null],
        redirect_uri: redirectUri,
        type: 'authorize',
      }),
    },
    [200],
  );

  if (
    isObject(start.json) &&
    start.json.type === 'create_entry' &&
    typeof start.json.result === 'string' &&
    start.json.result.length > 0
  ) {
    return start.json.result;
  }

  if (!isObject(start.json) || typeof start.json.flow_id !== 'string') {
    throw new Error('Unable to start Home Assistant login flow.');
  }

  const flowResponse = await httpJson(
    `/auth/login_flow/${start.json.flow_id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        username: ownerUsername,
        password: ownerPassword,
      }),
    },
    [200],
  );

  if (
    !isObject(flowResponse.json) ||
    flowResponse.json.type !== 'create_entry' ||
    typeof flowResponse.json.result !== 'string' ||
    flowResponse.json.result.length === 0
  ) {
    throw new Error(
      'Home Assistant login flow did not return an authorization code. Check DEV_HA_OWNER_USERNAME/DEV_HA_OWNER_PASSWORD.',
    );
  }

  return flowResponse.json.result;
}

async function exchangeAuthCodeForAccessToken(authCode) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    client_id: clientId,
  });

  const { json } = await httpJson(
    '/auth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    [200],
  );

  if (!isObject(json) || typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('Token exchange did not return access_token.');
  }

  return json.access_token;
}

async function markOnboardingSteps(accessToken, initialStatus) {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  if (!initialStatus.core_config) {
    await httpJson('/api/onboarding/core_config', { method: 'POST', headers: authHeaders }, [200, 403]);
  }

  if (!initialStatus.analytics) {
    await httpJson('/api/onboarding/analytics', { method: 'POST', headers: authHeaders }, [200, 403]);
  }

  if (!initialStatus.integration) {
    await httpJson(
      '/api/onboarding/integration',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
        }),
      },
      [200, 400, 403],
    );
  }
}

function createLongLivedAccessToken(accessToken) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let commandSent = false;

    const ws = new WebSocket(wsUrl);

    const finish = (err, token) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        ws.close();
      } catch {
        // no-op
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(token);
    };

    const timeoutHandle = setTimeout(() => {
      finish(new Error('Timed out while creating long-lived access token over websocket.'));
    }, 20000);

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (payload.type === 'auth_required') {
        ws.send(
          JSON.stringify({
            type: 'auth',
            access_token: accessToken,
          }),
        );
        return;
      }

      if (payload.type === 'auth_invalid') {
        finish(new Error(`Websocket authentication failed: ${payload.message || 'auth_invalid'}`));
        return;
      }

      if (payload.type === 'auth_ok' && !commandSent) {
        commandSent = true;
        ws.send(
          JSON.stringify({
            id: 1,
            type: 'auth/long_lived_access_token',
            client_name: tokenClientNameRun,
            lifespan: tokenLifespanDays,
          }),
        );
        return;
      }

      if (payload.id === 1) {
        if (payload.success === true && typeof payload.result === 'string' && payload.result.length > 0) {
          finish(null, payload.result);
          return;
        }
        finish(new Error(`Unable to create long-lived access token: ${JSON.stringify(payload.error || payload)}`));
      }
    });

    ws.addEventListener('error', () => {
      finish(new Error('Websocket connection error while creating long-lived access token.'));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        finish(
          new Error(
            commandSent
              ? 'Websocket closed before long-lived token command completed.'
              : 'Websocket closed before authentication completed.',
          ),
        );
      }
    });
  });
}

async function main() {
  const onboardingStatus = await getOnboardingStatus();

  let authCode;
  if (!onboardingStatus.user) {
    console.error('Home Assistant user onboarding not complete; creating default dev owner account.');
    authCode = await createOnboardingUserAuthCode();
  } else {
    console.error('Home Assistant user onboarding already complete; logging in with configured dev owner credentials.');
    authCode = await createLoginFlowAuthCode();
  }

  const accessToken = await exchangeAuthCodeForAccessToken(authCode);
  await markOnboardingSteps(accessToken, onboardingStatus);

  let tokenToUse = accessToken;
  try {
    tokenToUse = await createLongLivedAccessToken(accessToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Long-lived token creation failed (${message}). Falling back to short-lived access token for this run.`,
    );
  }

  process.stdout.write(tokenToUse);
}

main().catch((error) => {
  console.error(`Automatic Home Assistant bootstrap failed: ${error.message}`);
  process.exit(1);
});
