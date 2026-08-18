import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
const cloudflareAccess = await import(
  process.env.GOOGLE_HEALTH_MCP_CLOUDFLARE_ACCESS_TEST_MODULE ?? '../dist/services/cloudflare-access.js'
);
const {
  CLOUDFLARE_ACCESS_AUDIENCE_ENV,
  CLOUDFLARE_ACCESS_REQUIRED_ENV,
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV,
  createCloudflareAccessGuard,
  getCloudflareAccessConfig,
} = cloudflareAccess;

const teamDomain = 'https://team.example.cloudflareaccess.com';
const audience = 'test-access-application-audience';

assert.deepEqual(getCloudflareAccessConfig({}), { required: false });
assert.throws(
  () => getCloudflareAccessConfig({ [CLOUDFLARE_ACCESS_REQUIRED_ENV]: 'maybe' }),
  /must be true or false/
);
assert.throws(
  () => getCloudflareAccessConfig({
    [CLOUDFLARE_ACCESS_REQUIRED_ENV]: 'true',
    [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: teamDomain,
  }),
  /requires both/
);
assert.throws(
  () => getCloudflareAccessConfig({
    [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: teamDomain,
  }),
  /require .* =true|require .*true/
);
assert.throws(
  () => getCloudflareAccessConfig({
    [CLOUDFLARE_ACCESS_REQUIRED_ENV]: 'true',
    [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: 'http://team.example.cloudflareaccess.com',
    [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: audience,
  }),
  /must be an HTTPS team-domain origin/
);

const configured = getCloudflareAccessConfig({
  [CLOUDFLARE_ACCESS_REQUIRED_ENV]: 'true',
  [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: `${teamDomain}/`,
  [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: ` ${audience} `,
});
assert.deepEqual(configured, {
  required: true,
  teamDomain,
  audience,
  jwksUrl: `${teamDomain}/cdn-cgi/access/certs`,
});

assert.throws(
  () => createCloudflareAccessGuard({ required: true }),
  /configuration is incomplete/
);

const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
const keyId = 'test-cloudflare-access-key';
const jwks = createLocalJWKSet({
  keys: [{ ...publicJwk, alg: 'RS256', kid: keyId, use: 'sig' }],
});

async function createToken({ issuer = teamDomain, tokenAudience = audience, expiration = '2h' } = {}) {
  return new SignJWT({ sub: 'test-user' })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(issuer)
    .setAudience(tokenAudience)
    .setExpirationTime(expiration)
    .sign(privateKey);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/mcp', createCloudflareAccessGuard(configured, { jwks }), (_req, res) => {
  res.json({ ok: true });
});
app.post('/local-mcp', createCloudflareAccessGuard({ required: false }), (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, { method = 'GET', token } = {}) {
  const headers = {};
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : '{}',
  });
  return { status: response.status, body: await response.json() };
}

const logLines = [];
const originalConsoleError = console.error;
console.error = (...args) => logLines.push(args.map(String).join(' '));

try {
  assert.deepEqual(await request('/health'), { status: 200, body: { ok: true } });
  assert.deepEqual(await request('/local-mcp', { method: 'POST' }), { status: 200, body: { ok: true } });

  const missing = await request('/mcp', { method: 'POST' });
  assert.deepEqual(missing, { status: 403, body: { error: 'Forbidden' } });

  const malformed = await request('/mcp', { method: 'POST', token: 'not-a-jwt' });
  assert.deepEqual(malformed, { status: 403, body: { error: 'Forbidden' } });

  const expired = await createToken({ expiration: Math.floor(Date.now() / 1000) - 60 });
  const wrongIssuer = await createToken({ issuer: 'https://other.example.cloudflareaccess.com' });
  const wrongAudience = await createToken({ tokenAudience: 'other-access-audience' });
  const valid = await createToken();
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;

  for (const token of [expired, wrongIssuer, wrongAudience, tampered]) {
    assert.deepEqual(await request('/mcp', { method: 'POST', token }), {
      status: 403,
      body: { error: 'Forbidden' },
    });
  }

  assert.deepEqual(await request('/mcp', { method: 'POST', token: valid }), {
    status: 200,
    body: { ok: true },
  });

  const responseText = JSON.stringify(await request('/mcp', { method: 'POST', token: tampered }));
  assert.doesNotMatch(responseText, /not-a-jwt|test-user|other-access-audience/);
  assert.ok(logLines.every((line) => !line.includes(valid) && !line.includes(tampered)));

  console.log(JSON.stringify({ ok: true, suite: 'cloudflare-access' }, null, 2));
} finally {
  console.error = originalConsoleError;
  await new Promise((resolve) => server.close(resolve));
}
