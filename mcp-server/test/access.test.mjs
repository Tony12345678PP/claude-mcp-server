import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { accessConfigFromEnv, requireAccess } from '../dist/access.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-123';

const keyPair = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
};

const sign = (privateKey, { email = 'owner@example.com', iss = ISSUER, aud = AUD, exp = '5m', kid = 'k1' } = {}) => {
  const jwt = new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt();
  return jwt.setExpirationTime(exp).sign(privateKey);
};

const mockRes = () => {
  const res = { locals: {}, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const runGate = async (keys, token) => {
  const mw = requireAccess({ issuer: ISSUER, audience: AUD, keys });
  const req = { header: (name) => (name.toLowerCase() === 'cf-access-jwt-assertion' ? token : undefined) };
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
};

test('accepts a valid Access token and exposes the verified email', async () => {
  const { privateKey, keys } = await keyPair();
  const { res, nextCalled } = await runGate(keys, await sign(privateKey, { email: 'alice@example.com' }));
  assert.equal(nextCalled, true);
  assert.equal(res.locals.actor, 'alice@example.com');
});

test('rejects a missing header', async () => {
  const { keys } = await keyPair();
  const { res, nextCalled } = await runGate(keys, undefined);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'access_required');
});

test('rejects a token for another application audience', async () => {
  const { privateKey, keys } = await keyPair();
  const { nextCalled } = await runGate(keys, await sign(privateKey, { aud: 'someone-else' }));
  assert.equal(nextCalled, false);
});

test('rejects a token from another issuer', async () => {
  const { privateKey, keys } = await keyPair();
  const { nextCalled } = await runGate(keys, await sign(privateKey, { iss: 'https://evil.cloudflareaccess.com' }));
  assert.equal(nextCalled, false);
});

test('rejects an expired token', async () => {
  const { privateKey, keys } = await keyPair();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const { nextCalled } = await runGate(keys, await sign(privateKey, { exp: past }));
  assert.equal(nextCalled, false);
});

test('rejects a token signed with a key outside the JWKS', async () => {
  const trusted = await keyPair();
  const attacker = await keyPair();
  const { nextCalled } = await runGate(trusted.keys, await sign(attacker.privateKey));
  assert.equal(nextCalled, false);
});

test('config is null when unset and throws when only one of the pair is set', () => {
  assert.equal(accessConfigFromEnv({}), null);
  assert.throws(() => accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }), /must be set together/);
  assert.throws(() => accessConfigFromEnv({ ACCESS_AUD: AUD }), /must be set together/);
  const cfg = accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: AUD });
  assert.equal(cfg.issuer, ISSUER);
  assert.equal(cfg.audience, AUD);
});
