/* oxlint-disable rules/no-node-imports, node/no-sync -- These tests inspect the synchronous cache boundary and real Node filesystem permissions. */
/* oxlint-disable eslint/no-magic-numbers -- Literal test probabilities, HTTP statuses and timestamps document the boundary cases. */
/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements, vitest/max-expects -- Keep each scenario's wire, cache, and outcome checks together. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Path from 'node:path'

import { Effect, Predicate, Result } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

// oxlint-disable-next-line import/no-relative-parent-imports -- Both bindings consume this shared protocol fixture.
import sharedJevVector from '../moonbit/fixtures/jev-predicate-v1.json' with { type: 'json' }
// oxlint-disable-next-line import/no-relative-parent-imports -- Both bindings consume this shared protocol fixture.
import sharedSystemOneVector from '../moonbit/fixtures/jev-systemone-v1.json' with { type: 'json' }
// oxlint-disable-next-line import/no-relative-parent-imports -- Both bindings consume this shared protocol fixture.
import sharedVector from '../moonbit/fixtures/predicate-v1.json' with { type: 'json' }
import { createDecisionClient, DecisionError, lookupSync, predicateKey } from './decision-kit.ts'
import type { DecisionClient, DecisionErrorCode, PredicateRequest, RemoteCache } from './decision-kit.ts'

const request = {
  endpoint: 'https://gateway.ai.cloudflare.com/v1/mock/gateway/openai/decisions',
  input: '東京: broken 🚨',
  instructions: 'Is this urgent?',
  model: 'gpt-6-luna',
  name: 'urgent',
  scope: 'tenant:東京',
} satisfies PredicateRequest
const jevRequest = {
  ...request,
  endpoint: 'https://api.cloudflare.com/client/v4/accounts/mock/ai/run',
  gatewayId: 'test-gateway',
  model: 'typesafe/jev',
  provider: 'jev',
} satisfies PredicateRequest
const systemOneRequest = {
  ...request,
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  provider: 'jev',
} satisfies PredicateRequest
const proxyEndpoint = 'https://decisions.example.test:8443/custom/V2/predicate'
const key = '608522ea367b87110bafd75a590d712569324332f7f71351011f05de709f3c9e'
const answer = { name: request.name, probability: 0.75, type: 'predicate' }
const answerBody = { answers: [answer], model: request.model }
const filename = `${key}.json`
const jevAnswer = { noul: 0.25, type: 'noul' }
const jevCompleted = { result: { answers: { urgent: jevAnswer }, model: 'jev-1.13.0' }, state: 'Completed' }
const jevResponse = { result: jevCompleted, success: true }
const ttlSeconds = 60

const resolve = async (client: DecisionClient, input: PredicateRequest): Promise<number> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Run the public Effect at the test boundary.
  Effect.runPromise(client.resolve(input))

const resolution = async (
  client: DecisionClient,
  input: PredicateRequest,
): Promise<Result.Result<number, DecisionError>> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Assert on the typed failure channel at the test boundary.
  Effect.runPromise(Effect.result(client.resolve(input)))

const assertFailure = (result: Result.Result<number, DecisionError>, code: DecisionErrorCode): void => {
  expect(result).toMatchObject({ failure: { code } })
}

const useCache = (onTestFinished: (cleanup: () => void) => void): string => {
  const dir = mkdtempSync(Path.join(tmpdir(), 'decision-kit-test-'))
  onTestFinished(() => {
    rmSync(dir, { force: true, recursive: true })
  })
  return dir
}

const remoteClient = (
  cacheDir: string,
  transport: typeof globalThis.fetch,
  options: Readonly<{ endpoint?: string; gatewayToken?: string; remoteCache?: RemoteCache }> = {},
): DecisionClient =>
  createDecisionClient({
    ...options,
    cacheDir,
    fetch: transport,
    mode: 'remote',
    token: 'mock-token',
    ttlSeconds,
  })

const requestBody = (init?: RequestInit): unknown => {
  const body = init?.body
  if (Predicate.isString(body)) {
    return JSON.parse(body)
  }
  expect(body).toBeInstanceOf(Uint8Array)
  return body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(body)) : undefined
}

const cacheRecord = (now: number, probability = 0): object => ({
  createdAt: now,
  expiresAt: now + 500,
  key,
  probability,
  version: 1,
})

describe('predicate decisions', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('hashes v1 byte lengths, preserves Unicode, and rejects lone surrogates', () => {
    expect.hasAssertions()
    expect(predicateKey(sharedVector)).toBe(sharedVector.key)
    expect(predicateKey(request)).toBe(key)
    expect(predicateKey({ ...request, provider: 'openai-decisions' })).toBe(key)
    const changed = { ...request, input: 'e\u0301' }
    expect(predicateKey(changed)).not.toBe(predicateKey({ ...request, input: 'é' }))
    expect(predicateKey({ ...request, input: 'c', instructions: 'ab' })).not.toBe(
      predicateKey({ ...request, input: 'bc', instructions: 'a' }),
    )
    Object.keys(request).forEach((field) => {
      expect(predicateKey({ ...request, [field]: 'changed' })).not.toBe(key)
      expect(() => predicateKey({ ...request, [field]: '\uD800' })).toThrow(DecisionError)
    })
    const blankScopes = ['', ' \t\n']
    blankScopes.forEach((scope) => {
      expect(() => predicateKey({ ...request, scope })).toThrow(DecisionError)
    })
  })

  test('matches the independent Jev Unicode and Gateway-scoped v1 key', () => {
    const { key: expected, model, provider, ...fields } = sharedJevVector
    expect({ model, provider }).toStrictEqual({ model: 'typesafe/jev', provider: 'jev' })
    expect(predicateKey({ ...fields, model: 'typesafe/jev', provider: 'jev' })).toBe(expected)
  })

  test('matches the independent direct Jev System One cache key', () => {
    const { key: expected, model, provider, ...fields } = sharedSystemOneVector
    expect({ model, provider }).toStrictEqual({ model: 'jev-latest', provider: 'jev' })
    expect(predicateKey({ ...fields, model: 'jev-latest', provider: 'jev' })).toBe(expected)
  })

  test('lookup and resolution are lazy and cache-only lookup is synchronous', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerBody))
    const client = remoteClient(cacheDir, transport)
    const lookup = client.lookup(request)
    const online = client.resolve(request)
    expect(transport).not.toHaveBeenCalled()
    expect(readdirSync(cacheDir)).toStrictEqual([])
    assertFailure(lookupSync(client, request), 'cache-miss')
    const offline = createDecisionClient({ cacheDir, ttlSeconds })
    assertFailure(await resolution(offline, request), 'cache-miss')
    expect(transport).not.toHaveBeenCalled()
    // oxlint-disable-next-line rules/no-effect-runtime-run -- Execute the previously created remote effect in this test.
    await expect(Effect.runPromise(online)).resolves.toBe(0.75)
    expect(transport).toHaveBeenCalledOnce()
    // oxlint-disable-next-line rules/no-effect-runtime-run -- An already created lookup reads the cache only when executed.
    expect(Effect.runSync(lookup)).toBe(0.75)
    expect(lookupSync(offline, request)).toStrictEqual(Result.succeed(0.75))
  })

  test('accepts only valid cache records within both freshness windows', ({ onTestFinished }) => {
    expect.hasAssertions()
    const cacheDir = useCache(onTestFinished)
    const client = createDecisionClient({ cacheDir, ttlSeconds })
    const now = 1_700_000_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now * 1000)
    const valid = cacheRecord(now)
    const path = Path.join(cacheDir, filename)
    const probabilities = [0, 0.5, 1]
    probabilities.forEach((probability) => {
      writeFileSync(path, JSON.stringify({ ...valid, probability }))
      expect(lookupSync(client, request)).toStrictEqual(Result.succeed(probability))
    })
    writeFileSync(path, JSON.stringify({ ...valid, createdAt: now - 59, expiresAt: now + 1 }))
    expect(lookupSync(client, request)).toStrictEqual(Result.succeed(0))
    const stale = [{ createdAt: now + 1 }, { createdAt: now - 60 }, { expiresAt: now }]
    stale.forEach((fields) => {
      writeFileSync(path, JSON.stringify({ ...valid, ...fields }))
      assertFailure(lookupSync(client, request), 'cache-miss')
    })
    const invalidFields = [
      { version: 2 },
      { key: 'wrong' },
      { createdAt: now + 0.1 },
      { expiresAt: `${now}` },
      { probability: 2 },
      { probability: '0' },
    ]
    const invalidBodies = [
      '{',
      '[]',
      JSON.stringify(valid).replace('"probability":0', '"probability":1e309'),
      Buffer.from([192, 128]),
      ...invalidFields.map((fields) => JSON.stringify({ ...valid, ...fields })),
    ]
    invalidBodies.forEach((body) => {
      writeFileSync(path, body)
      assertFailure(lookupSync(client, request), 'cache-invalid')
    })
  })

  test('validates cache settings in the typed failure channel', ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const invalidTtls = [0, 59, 60.5, 2_592_001, Number.NaN]
    invalidTtls.forEach((ttl) => {
      const client = createDecisionClient({ cacheDir, ttlSeconds: ttl })
      assertFailure(lookupSync(client, request), 'invalid-configuration')
    })
    const client = createDecisionClient({ cacheDir, ttlSeconds: 2_592_000 })
    expect(lookupSync(client, request)).toMatchObject({ failure: { code: 'cache-miss' } })
  })

  test('openAI sends one opt-in request and writes a private v1 cache record', async ({ onTestFinished }) => {
    const cacheDir = Path.join(useCache(onTestFinished), 'nested')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerBody))
    const client = remoteClient(cacheDir, transport)
    await expect(resolve(client, request)).resolves.toBe(0.75)
    await expect(resolve(client, request)).resolves.toBe(0.75)
    expect(transport).toHaveBeenCalledOnce()
    const [[url, init] = []] = transport.mock.calls
    expect(url).toHaveProperty('href', request.endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = Object.fromEntries(new Headers(init?.headers))
    expect(headers).toStrictEqual({
      'cf-aig-authorization': 'Bearer mock-token',
      'cf-aig-cache-key': `decision-v1-${key}`,
      'cf-aig-cache-ttl': `${ttlSeconds}`,
      'cf-aig-skip-cache': 'false',
      'content-type': 'application/json',
    })
    expect(requestBody(init)).toStrictEqual({
      input: request.input,
      model: request.model,
      questions: [{ instructions: request.instructions, name: request.name, type: 'predicate' }],
    })
    expect(readdirSync(cacheDir)).toStrictEqual([filename])
    const path = Path.join(cacheDir, filename)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toStrictEqual({
      createdAt: 1_700_000_000,
      expiresAt: 1_700_000_060,
      key,
      probability: 0.75,
      version: 1,
    })
  })

  test.skipIf(process.platform === 'win32')('creates private POSIX cache entries', async ({ onTestFinished }) => {
    const cacheDir = Path.join(useCache(onTestFinished), 'private')
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerBody))
    await resolve(remoteClient(cacheDir, transport), request)
    const modes = [statSync(cacheDir).mode, statSync(Path.join(cacheDir, filename)).mode]
    // oxlint-disable-next-line eslint/no-bitwise -- POSIX groups and other permission bits are represented as a mask.
    expect(modes.map((mode) => mode & 0o077)).toStrictEqual([0, 0])
  })

  test('jev sends the universal Workers AI request and never reuses another provider or Gateway cache entry', async ({
    onTestFinished,
  }) => {
    const cacheDir = useCache(onTestFinished)
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(jevResponse))
      .mockResolvedValueOnce(Response.json(answerBody))
    const client = remoteClient(cacheDir, transport)
    const jevKey = predicateKey(jevRequest)
    expect(jevKey).not.toBe(key)
    expect(jevKey).not.toBe(predicateKey({ ...jevRequest, gatewayId: 'another' }))
    await expect(resolve(client, jevRequest)).resolves.toBe(0.25)
    await expect(resolve(client, jevRequest)).resolves.toBe(0.25)
    expect(transport).toHaveBeenCalledOnce()
    const [[url, init] = []] = transport.mock.calls
    expect(url).toHaveProperty('href', jevRequest.endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = Object.fromEntries(new Headers(init?.headers))
    expect(headers).toStrictEqual({
      authorization: 'Bearer mock-token',
      'cf-aig-cache-key': `decision-v1-${jevKey}`,
      'cf-aig-cache-ttl': `${ttlSeconds}`,
      'cf-aig-gateway-id': jevRequest.gatewayId,
      'cf-aig-skip-cache': 'false',
      'content-type': 'application/json',
    })
    expect(requestBody(init)).toStrictEqual({
      input: { questions: { urgent: { instructions: request.instructions, type: 'noul' } }, state: request.input },
      model: jevRequest.model,
    })
    assertFailure(lookupSync(client, request), 'cache-miss')
    assertFailure(lookupSync(client, { ...jevRequest, gatewayId: 'another' }), 'cache-miss')
    await expect(resolve(client, request)).resolves.toBe(0.75)
    expect(readdirSync(cacheDir).toSorted()).toStrictEqual([`${jevKey}.json`, filename].toSorted())
  })

  test('does not send credentials to any endpoint outside the selected provider route', async ({ onTestFinished }) => {
    const transport = vi.fn<typeof globalThis.fetch>()
    const client = remoteClient(useCache(onTestFinished), transport)
    const endpoints = [
      { ...request, endpoint: 'https://direct.example.test/openai/decisions' },
      {
        ...request,
        endpoint: request.endpoint.replace('gateway.ai.cloudflare.com', 'gateway.ai.cloudflare.com@example.test'),
      },
      { ...request, endpoint: request.endpoint.replace('https:', 'http:') },
      { ...request, endpoint: `${request.endpoint}?forward=untrusted` },
      { ...request, endpoint: `${request.endpoint}\n` },
      { ...request, endpoint: jevRequest.endpoint },
      { ...jevRequest, endpoint: request.endpoint },
      { ...jevRequest, endpoint: 'https://api.typesafe.ai/v1/run' },
      { ...jevRequest, endpoint: systemOneRequest.endpoint },
      { ...request, endpoint: systemOneRequest.endpoint },
      { ...systemOneRequest, endpoint: jevRequest.endpoint },
      { ...jevRequest, endpoint: `${jevRequest.endpoint}?gateway=other` },
      { ...jevRequest, gatewayId: 'invalid\n' },
    ]
    await Promise.all(
      endpoints.map(async (candidate) => {
        assertFailure(await resolution(client, candidate), 'invalid-request')
      }),
    )
    expect(transport).not.toHaveBeenCalled()
  })

  test('pins the full proxy URL and does not fall back to a standard endpoint', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerBody))
    const client = remoteClient(cacheDir, transport, { endpoint: proxyEndpoint })
    const candidate = { ...request, endpoint: proxyEndpoint }
    assertFailure(await resolution(client, request), 'invalid-request')
    assertFailure(await resolution(client, { ...candidate, endpoint: `${proxyEndpoint}/` }), 'invalid-request')
    expect(transport).not.toHaveBeenCalled()
    await expect(resolve(client, candidate)).resolves.toBe(0.75)
    const [[url, init] = []] = transport.mock.calls
    expect(url).toHaveProperty('href', proxyEndpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(Object.fromEntries(new Headers(init?.headers))).toStrictEqual({
      authorization: 'Bearer mock-token',
      'content-type': 'application/json',
    })
    expect(requestBody(init)).toStrictEqual({
      input: request.input,
      model: request.model,
      questions: [{ instructions: request.instructions, name: request.name, type: 'predicate' }],
    })
  })

  test('rejects malformed pins before invoking the transport', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const transport = vi.fn<typeof globalThis.fetch>()
    const endpoints = [
      '/custom/V2/predicate',
      'http://decisions.example.test/path',
      'https://user@decisions.example.test/path',
      String.raw`https://decisions.example.test\other.test/path`,
      'https://decisions.example.test:0/path',
      'https://decisions.example.test:65536/path',
      'https://decisions.example.test:08443/path',
      'https://Decisions.example.test/path',
      'https://127.0.0.1/path',
      'https://-decisions.example.test/path',
      `https://${'a'.repeat(64)}.example.test/path`,
      'https://decisions.example.test',
      'https://decisions.example.test/a//path',
      'https://decisions.example.test/a/../path',
      'https://decisions.example.test/a/./path',
      'https://decisions.example.test/a%2fpath',
      'https://decisions.example.test/a%2e/path',
      `${proxyEndpoint}?`,
      `${proxyEndpoint}#`,
      `${proxyEndpoint}\t`,
      `${proxyEndpoint}\n`,
      `${proxyEndpoint} path`,
    ]
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const client = remoteClient(cacheDir, transport, { endpoint })
        assertFailure(await resolution(client, { ...request, endpoint }), 'invalid-configuration')
      }),
    )
    expect(transport).not.toHaveBeenCalled()
  })

  test('opts official direct OpenAI in to Cloudflare headers without changing authorization or the local key', async ({
    onTestFinished,
  }) => {
    const candidate = { ...request, endpoint: 'https://api.openai.com/v1/decisions' }
    const cacheDir = useCache(onTestFinished)
    const requestKey = predicateKey(candidate)
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerBody))
    const cloudflare = remoteClient(cacheDir, transport, { remoteCache: 'cloudflare' })
    await expect(resolve(cloudflare, candidate)).resolves.toBe(0.75)
    const [[url, init] = []] = transport.mock.calls
    expect(url).toHaveProperty('href', candidate.endpoint)
    expect(Object.fromEntries(new Headers(init?.headers))).toStrictEqual({
      authorization: 'Bearer mock-token',
      'cf-aig-cache-key': `decision-v1-${requestKey}`,
      'cf-aig-cache-ttl': `${ttlSeconds}`,
      'cf-aig-skip-cache': 'false',
      'content-type': 'application/json',
    })
    const none = remoteClient(cacheDir, transport, { remoteCache: 'none' })
    await expect(resolve(none, candidate)).resolves.toBe(0.75)
    expect(transport).toHaveBeenCalledOnce()
    expect(readdirSync(cacheDir)).toStrictEqual([`${requestKey}.json`])
  })

  test('omits only the cache headers when disabled on both canonical Cloudflare protocols', async ({
    onTestFinished,
  }) => {
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(answerBody))
      .mockResolvedValueOnce(Response.json(jevResponse))
    const client = remoteClient(useCache(onTestFinished), transport, { remoteCache: 'none' })
    await expect(resolve(client, request)).resolves.toBe(0.75)
    await expect(resolve(client, jevRequest)).resolves.toBe(0.25)
    const headers = transport.mock.calls.map(([, init]) => Object.fromEntries(new Headers(init?.headers)))
    expect(headers).toStrictEqual([
      { 'cf-aig-authorization': 'Bearer mock-token', 'content-type': 'application/json' },
      {
        authorization: 'Bearer mock-token',
        'cf-aig-gateway-id': jevRequest.gatewayId,
        'content-type': 'application/json',
      },
    ])
  })

  test('sends direct Jev to System One and a pinned proxy using the unwrapped protocol', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const pinned = {
      ...systemOneRequest,
      endpoint: proxyEndpoint,
      model: 'jev-1.13.0',
    } as const satisfies PredicateRequest
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...jevCompleted.result, usage: { input_tokens: 50 } }))
      .mockResolvedValueOnce(Response.json(jevCompleted.result))
    await expect(resolve(remoteClient(cacheDir, transport), systemOneRequest)).resolves.toBe(0.25)
    await expect(resolve(remoteClient(cacheDir, transport, { endpoint: proxyEndpoint }), pinned)).resolves.toBe(0.25)
    const calls = transport.mock.calls.map(([url, init]) => ({
      body: requestBody(init),
      headers: Object.fromEntries(new Headers(init?.headers)),
      url,
    }))
    expect(calls).toMatchObject(
      [systemOneRequest, pinned].map((candidate) => ({
        body: {
          model: candidate.model,
          questions: { urgent: { instructions: candidate.instructions, type: 'noul' } },
          state: candidate.input,
        },
        url: { href: candidate.endpoint },
      })),
    )
    expect(calls.map(({ headers }) => headers)).toStrictEqual([
      { authorization: 'Bearer mock-token', 'content-type': 'application/json' },
      { authorization: 'Bearer mock-token', 'content-type': 'application/json' },
    ])
  })

  test('separates provider-native Jev gateway credentials from the remote cache policy', async ({ onTestFinished }) => {
    const endpoint = 'https://gateway.ai.cloudflare.com/v1/mock/gateway/typesafe/v1/systemone'
    const candidate = { ...systemOneRequest, endpoint }
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(jevCompleted.result))
      .mockResolvedValueOnce(Response.json(jevCompleted.result))
      .mockResolvedValueOnce(Response.json(jevCompleted.result))
    const storedKey = remoteClient(useCache(onTestFinished), transport, { endpoint })
    await expect(resolve(storedKey, candidate)).resolves.toBe(0.25)
    const gatewayToken = 'mock-gateway-token'
    const providerKey = remoteClient(useCache(onTestFinished), transport, {
      endpoint,
      gatewayToken,
      remoteCache: 'none',
    })
    await expect(resolve(providerKey, candidate)).resolves.toBe(0.25)
    const providerKeyWithCache = remoteClient(useCache(onTestFinished), transport, {
      endpoint,
      gatewayToken,
      remoteCache: 'cloudflare',
    })
    await expect(resolve(providerKeyWithCache, candidate)).resolves.toBe(0.25)
    const headers = transport.mock.calls.map(([, init]) => Object.fromEntries(new Headers(init?.headers)))
    const separateAuth = {
      authorization: 'Bearer mock-token',
      'cf-aig-authorization': `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
    }
    expect(headers).toStrictEqual([
      { 'cf-aig-authorization': 'Bearer mock-token', 'content-type': 'application/json' },
      separateAuth,
      {
        ...separateAuth,
        'cf-aig-cache-key': `decision-v1-${predicateKey(candidate)}`,
        'cf-aig-cache-ttl': `${ttlSeconds}`,
        'cf-aig-skip-cache': 'false',
      },
    ])
  })

  test('rejects an invalid or ineligible gatewayToken before invoking the transport', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const transport = vi.fn<typeof globalThis.fetch>()
    const samples = [
      { candidate: request, options: { gatewayToken: 'invalid token' } },
      { candidate: jevRequest, options: { gatewayToken: 'mock-gateway-token' } },
      { candidate: systemOneRequest, options: { gatewayToken: 'mock-gateway-token' } },
      ...['https://gateway.ai.cloudflare.com.fake.test/path', 'https://gateway.ai.cloudflare.com:8443/path'].map(
        (endpoint) => ({
          candidate: { ...systemOneRequest, endpoint },
          options: { endpoint, gatewayToken: 'mock-gateway-token' },
        }),
      ),
    ]
    await Promise.all(
      samples.map(async ({ candidate, options }) => {
        assertFailure(await resolution(remoteClient(cacheDir, transport, options), candidate), 'invalid-configuration')
      }),
    )
    expect(transport).not.toHaveBeenCalled()
  })

  test('rejects cross-protocol and mismatched System One responses', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const release = { ...systemOneRequest, model: 'jev-1.14.0' } as const satisfies PredicateRequest
    const samples = [
      { candidate: systemOneRequest, payload: jevResponse },
      { candidate: systemOneRequest, payload: answerBody },
      { candidate: systemOneRequest, payload: { ...jevCompleted.result, error: { message: 'not a decision' } } },
      { candidate: systemOneRequest, payload: { ...jevCompleted.result, model: 'jev-preview' } },
      { candidate: release, payload: jevCompleted.result },
      { candidate: request, payload: jevCompleted.result },
      { candidate: jevRequest, payload: jevCompleted.result },
    ]
    await Promise.all(
      samples.map(async ({ candidate, payload }) => {
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload))
        assertFailure(await resolution(remoteClient(cacheDir, transport), candidate), 'invalid-response')
      }),
    )
    expect(readdirSync(cacheDir)).toStrictEqual([])
  })

  test('failed atomic replacement cleans up its temporary file', async ({ onTestFinished }) => {
    const cacheDir = useCache(onTestFinished)
    const client = remoteClient(cacheDir, async () => {
      await mkdir(Path.join(cacheDir, filename))
      return Response.json(answerBody)
    })
    assertFailure(await resolution(client, request), 'cache-write')
    expect(readdirSync(cacheDir)).toStrictEqual([filename])
    expect(statSync(Path.join(cacheDir, filename)).isDirectory()).toBe(true)
    assertFailure(lookupSync(client, request), 'cache-read')
  })

  test('validates in-flight judgments against a request snapshot', async ({ onTestFinished }) => {
    const candidate = { ...request }
    // oxlint-disable-next-line typescript/require-await -- The injected fetch mutates the source object after the request begins.
    const client = remoteClient(useCache(onTestFinished), async () => {
      candidate.name = 'changed-while-in-flight'
      return Response.json(answerBody)
    })
    await expect(resolve(client, candidate)).resolves.toBe(0.75)
    expect(lookupSync(client, request)).toStrictEqual(Result.succeed(0.75))
    assertFailure(lookupSync(client, candidate), 'cache-miss')
  })

  test('rejects HTTP, malformed, incomplete, mismatched, and out-of-range results without caching them', async ({
    onTestFinished,
  }) => {
    const cacheDir = useCache(onTestFinished)
    const openAIInvalid = [
      { ...answerBody, error: { message: 'not a decision' } },
      { ...answerBody, model: 'unexpected-model' },
      { ...answerBody, answers: [] },
      { ...answerBody, answers: [answer, answer] },
      { ...answerBody, answers: [{ ...answer, name: 'wrong' }] },
      { ...answerBody, answers: [{ ...answer, type: 'score' }] },
      { ...answerBody, answers: [{ ...answer, probability: 1.1 }] },
      { ...answerBody, answers: [{ ...answer, probability: '0.75' }] },
    ]
    const jevResults = [
      { ...jevCompleted.result, model: 'gpt-6-luna' },
      { ...jevCompleted.result, answers: {} },
      { ...jevCompleted.result, answers: { wrong: jevAnswer } },
      { ...jevCompleted.result, answers: { urgent: jevAnswer, wrong: jevAnswer } },
      { ...jevCompleted.result, answers: { urgent: { ...jevAnswer, noul: 1.1 } } },
      { ...jevCompleted.result, answers: { urgent: { ...jevAnswer, noul: '0.25' } } },
      { ...jevCompleted.result, answers: { urgent: { ...jevAnswer, type: 'score' } } },
    ]
    const jevInvalid = [
      { ...jevResponse, success: false },
      { ...jevResponse, result: { ...jevCompleted, state: 'Running' } },
      { ...jevResponse, result: jevCompleted.result },
      answerBody,
      ...jevResults.map((result) => ({ result: { result, state: 'Completed' }, success: true })),
    ]
    const invalidCode: DecisionErrorCode = 'invalid-response'
    const samples = [
      ...openAIInvalid.map((value) => ({ candidate: request, code: invalidCode, response: Response.json(value) })),
      ...jevInvalid.map((value) => ({ candidate: jevRequest, code: invalidCode, response: Response.json(value) })),
      { candidate: request, code: 'http', response: Response.redirect('https://example.test') },
      { candidate: jevRequest, code: 'http', response: new Response('mock-token', { status: 401 }) },
      { candidate: request, code: 'invalid-response', response: new Response('malformed JSON') },
    ] satisfies { candidate: PredicateRequest; response: Response; code: DecisionErrorCode }[]
    await Promise.all(
      samples.map(async ({ candidate, code, response }) => {
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
        const client = remoteClient(cacheDir, transport)
        assertFailure(await resolution(client, candidate), code)
      }),
    )
    const failingTransport = vi.fn<typeof globalThis.fetch>().mockRejectedValue('mock-token')
    const result = await resolution(remoteClient(cacheDir, failingTransport), request)
    assertFailure(result, 'network')
    expect(JSON.stringify(result)).not.toContain('mock-token')
    expect(readdirSync(cacheDir)).toStrictEqual([])
  })
})
