import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createDecisionClient, DecisionError, predicateKey } from './index.ts';
import type { DecisionErrorCode, PredicateRequest } from './index.ts';
import sharedVector from '../fixtures/predicate-v1.json' with { type: 'json' };

const req = {
  endpoint: 'https://gateway.ai.cloudflare.com/v1/mock/gateway/openai/decisions',
  scope: 'tenant:東京',
  model: 'gpt-6-luna',
  name: 'urgent',
  instructions: 'Is this urgent?',
  input: '東京: broken 🚨',
} satisfies PredicateRequest;
const key = '608522ea367b87110bafd75a590d712569324332f7f71351011f05de709f3c9e';
const answer = { type: 'predicate', name: req.name, probability: 0.75 };
const answerBody = { model: req.model, answers: [answer] };
const filename = `${key}.json`;

function cacheDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'decision-kit-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function errorCode(code: DecisionErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof DecisionError && error.code === code;
}

test('v1 hashes byte lengths, preserves exact Unicode and rejects lone surrogates', () => {
  for (const scope of ['', ' \t\n']) {
    assert.throws(() => predicateKey({ ...req, scope }), errorCode('invalid-request'));
  }
  assert.equal(predicateKey(sharedVector), sharedVector.key);
  assert.equal(predicateKey(req), key);
  for (const field of Object.keys(req)) {
    assert.notEqual(predicateKey({ ...req, [field]: 'changed' }), key);
    assert.throws(() => predicateKey({ ...req, [field]: '\ud800' }), errorCode('invalid-request'));
  }
  assert.notEqual(predicateKey({ ...req, input: 'é' }), predicateKey({ ...req, input: 'e\u0301' }));
  assert.notEqual(predicateKey({ ...req, instructions: 'ab', input: 'c' }), predicateKey({ ...req, instructions: 'a', input: 'bc' }));
});

test('lookup and default resolve report a miss without writing or calling fetch', async (t) => {
  const dir = cacheDir(t);
  const network = t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('Unexpected call')));
  const client = createDecisionClient({ cacheDir: dir, ttlSeconds: 60 });
  assert.throws(() => client.lookup(req), errorCode('cache-miss'));
  await assert.rejects(client.resolve(req), errorCode('cache-miss'));
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('lookup accepts only well-formed cache records inside both freshness windows', (t) => {
  const dir = cacheDir(t);
  const client = createDecisionClient({ cacheDir: dir, ttlSeconds: 60 });
  const now = 1_700_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const valid = { version: 1, key, createdAt: now, expiresAt: now + 500, probability: 0 };
  const path = join(dir, filename);
  for (const probability of [0, 0.5, 1]) {
    writeFileSync(path, JSON.stringify({ ...valid, probability }));
    assert.equal(client.lookup(req), probability);
  }
  writeFileSync(path, JSON.stringify({ ...valid, createdAt: now - 59, expiresAt: now + 1 }));
  assert.equal(client.lookup(req), 0);
  for (const fields of [{ createdAt: now + 1 }, { createdAt: now - 60 }, { expiresAt: now }]) {
    writeFileSync(path, JSON.stringify({ ...valid, ...fields }));
    assert.throws(() => client.lookup(req), errorCode('cache-miss'));
  }
  for (const fields of [{ version: 2 }, { key: 'wrong' }, { createdAt: now + 0.1 }, { expiresAt: `${now}` }, { probability: 2 }, { probability: '0' }]) {
    writeFileSync(path, JSON.stringify({ ...valid, ...fields }));
    assert.throws(() => client.lookup(req), errorCode('cache-invalid'));
  }
  for (const body of ['{', '[]', JSON.stringify(valid).replace('"probability":0', '"probability":1e309'), Buffer.from([0xc0, 0x80])]) {
    writeFileSync(path, body);
    assert.throws(() => client.lookup(req), errorCode('cache-invalid'));
  }
});

test('rejects TTL outside 60 through 2592000 inclusive', (t) => {
  const dir = cacheDir(t);
  for (const ttlSeconds of [0, 59, 60.5, 2_592_001, Number.NaN]) {
    assert.throws(() => createDecisionClient({ cacheDir: dir, ttlSeconds }), errorCode('invalid-configuration'));
  }
  for (const ttlSeconds of [60, 2_592_000]) {
    assert.doesNotThrow(() => createDecisionClient({ cacheDir: dir, ttlSeconds }));
  }
});

test('remote resolve sends the exact opt-in request and leaves only a reusable private cache record', async (t) => {
  const dir = join(cacheDir(t), 'nested');
  const ttlSeconds = 180;
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const fakeFetch = t.mock.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, req.endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      'content-type': 'application/json',
      'cf-aig-authorization': 'Bearer mock-token',
      'cf-aig-cache-key': `decision-v1-${key}`,
      'cf-aig-cache-ttl': String(ttlSeconds),
      'cf-aig-skip-cache': 'false',
    });
    assert.ok(typeof init.body === 'string');
    assert.deepEqual(JSON.parse(init.body), {
      model: req.model,
      input: req.input,
      questions: [{ type: 'predicate', name: req.name, instructions: req.instructions }],
    });
    return Response.json(answerBody);
  });
  const client = createDecisionClient({ cacheDir: dir, ttlSeconds, mode: 'remote', token: 'mock-token', fetch: fakeFetch });
  assert.throws(() => client.lookup(req), errorCode('cache-miss'));
  assert.equal(await client.resolve(req), 0.75);
  assert.equal(await client.resolve(req), 0.75);
  assert.equal(fakeFetch.mock.callCount(), 1);
  const offline = createDecisionClient({ cacheDir: dir, ttlSeconds });
  assert.equal(offline.lookup(req), 0.75);
  assert.equal(await offline.resolve(req), 0.75);
  assert.deepEqual(readdirSync(dir), [filename]);
  const path = join(dir, filename);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    version: 1, key, createdAt: 1_700_000_000, expiresAt: 1_700_000_180, probability: 0.75,
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o077, 0);
    assert.equal(statSync(path).mode & 0o077, 0);
  }
});

test('remote mode never passes a token to a non-Gateway endpoint', async (t) => {
  const fetcher = t.mock.fn<typeof fetch>();
  const client = createDecisionClient({ cacheDir: cacheDir(t), ttlSeconds: 60, mode: 'remote', token: 'mock-token', fetch: fetcher });
  for (const endpoint of [
    'https://example.test/v1/mock/gateway/openai/decisions',
    req.endpoint.replace('gateway.ai.cloudflare.com', 'gateway.ai.cloudflare.com@example.test'),
    req.endpoint.replace('https:', 'http:'),
    `${req.endpoint}?forward=untrusted`,
    `${req.endpoint}\n`,
  ]) {
    await assert.rejects(client.resolve({ ...req, endpoint }), errorCode('invalid-request'));
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test('failed atomic replacement is visible and cleans up its temporary file', async (t) => {
  const dir = cacheDir(t);
  const client = createDecisionClient({
    cacheDir: dir,
    ttlSeconds: 60,
    mode: 'remote',
    token: 'mock-token',
    async fetch() {
      mkdirSync(join(dir, filename));
      return Response.json(answerBody);
    },
  });
  await assert.rejects(client.resolve(req), errorCode('cache-write'));
  assert.deepEqual(readdirSync(dir), [filename]);
  assert.ok(statSync(join(dir, filename)).isDirectory());
  assert.throws(() => client.lookup(req), errorCode('cache-read'));
});

test('an in-flight request is validated against the original model and name', async (t) => {
  const request = { ...req };
  const client = createDecisionClient({
    cacheDir: cacheDir(t),
    ttlSeconds: 60,
    mode: 'remote',
    token: 'mock-token',
    async fetch() {
      request.name = 'changed-while-in-flight';
      return Response.json(answerBody);
    },
  });
  assert.equal(await client.resolve(request), 0.75);
  assert.equal(client.lookup(req), 0.75);
  assert.throws(() => client.lookup(request), errorCode('cache-miss'));
});

test('transport failures and invalid responses are explicit and leave no cache entries', async (t) => {
  const dir = cacheDir(t);
  const invalidBodies = [
    { ...answerBody, error: { message: 'not a decision' } },
    { ...answerBody, model: 'not-the-requested-model' },
    { ...answerBody, answers: [] },
    { ...answerBody, answers: [answer, answer] },
    { ...answerBody, answers: [{ ...answer, name: 'wrong' }] },
    { ...answerBody, answers: [{ ...answer, type: 'score' }] },
    { ...answerBody, answers: [{ ...answer, probability: 1.1 }] },
    { ...answerBody, answers: [{ ...answer, probability: '0.75' }] },
  ];
  const samples: ReadonlyArray<readonly [DecisionErrorCode, typeof fetch]> = [
    ['network', async () => { throw new Error('mock-token'); }],
    ['http', async () => Response.redirect('https://example.test')],
    ['http', async () => new Response('mock-token', { status: 401 })],
    ['invalid-response', async () => new Response('malformed JSON')],
    ...invalidBodies.map((value) => ['invalid-response', async () => Response.json(value)] satisfies [DecisionErrorCode, typeof fetch]),
  ];
  for (const [code, fetcher] of samples) {
    const client = createDecisionClient({ cacheDir: dir, ttlSeconds: 60, mode: 'remote', token: 'mock-token', fetch: fetcher });
    await assert.rejects(client.resolve(req), (error: unknown) =>
      error instanceof DecisionError && error.code === code && !error.message.includes('mock-token') && error.cause === undefined,
    );
    assert.deepEqual(readdirSync(dir), []);
  }
});
