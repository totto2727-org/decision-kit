import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface PredicateRequest {
  readonly endpoint: string;
  readonly scope: string;
  readonly model: string;
  readonly name: string;
  readonly instructions: string;
  readonly input: string;
}

interface CacheOptions {
  readonly cacheDir: string;
  readonly ttlSeconds: number;
}

export type DecisionClientOptions = CacheOptions & (
  | { readonly mode?: 'cache-only' }
  | {
    readonly mode: 'remote';
    readonly token: string;
    readonly fetch?: typeof globalThis.fetch;
  }
);

export type DecisionErrorCode =
  | 'invalid-request'
  | 'invalid-configuration'
  | 'cache-miss'
  | 'cache-invalid'
  | 'cache-read'
  | 'cache-write'
  | 'network'
  | 'http'
  | 'invalid-response';

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly status?: number;

  constructor(code: DecisionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface DecisionClient {
  /** Read only local state, regardless of the configured mode. */
  lookup(request: PredicateRequest): number;
  /** Read local state first and request a decision on a miss only in remote mode. */
  resolve(request: PredicateRequest): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSecond(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** SHA-256 of the v1 UTF-8 length-prefixed frames, as lowercase hexadecimal. */
export function predicateKey(request: PredicateRequest): string {
  const hash = createHash('sha256');
  const { scope, endpoint, model, name, instructions, input } = request;
  if (typeof scope !== 'string' || scope.trim().length === 0) {
    throw new DecisionError('invalid-request', 'A nonblank authorization scope is required.');
  }
  for (const field of ['decision-kit/predicate/v1', scope, endpoint, model, name, instructions, input]) {
    if (typeof field !== 'string' || !field.isWellFormed()) {
      throw new DecisionError('invalid-request', 'Predicate fields must be well-formed UTF-8 strings.');
    }
    hash.update(`${Buffer.byteLength(field, 'utf8')}:`, 'ascii');
    hash.update(field, 'utf8');
  }
  return hash.digest('hex');
}

function readCache(path: string, key: string, ttl: number): number {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new DecisionError('cache-miss', 'No local predicate decision for this request.');
    }
    if (error instanceof TypeError) {
      throw new DecisionError('cache-invalid', 'Local predicate decision is not valid UTF-8.');
    }
    throw new DecisionError('cache-read', 'Could not read the local predicate decision.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DecisionError('cache-invalid', 'Local predicate decision is not valid JSON.');
  }
  if (!isRecord(value) || value.version !== 1 || value.key !== key ||
    !isSecond(value.createdAt) || !isSecond(value.expiresAt) || !isProbability(value.probability)) {
    throw new DecisionError('cache-invalid', 'Local predicate decision does not match the v1 cache contract.');
  }
  const now = nowSeconds();
  if (value.createdAt > now || now >= value.expiresAt || now - value.createdAt >= ttl) {
    throw new DecisionError('cache-miss', 'Local predicate decision is outside its freshness window.');
  }
  return value.probability;
}

async function writeCache(dir: string, path: string, key: string, ttl: number, probability: number): Promise<void> {
  const createdAt = nowSeconds();
  const record = { version: 1, key, createdAt, expiresAt: createdAt + ttl, probability };
  const temporaryPath = join(dir, `.${key}.${randomUUID()}.tmp`);
  let ownsTemporaryFile = false;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = await open(temporaryPath, 'wx', 0o600);
    ownsTemporaryFile = true;
    try {
      await file.writeFile(JSON.stringify(record), 'utf8');
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    ownsTemporaryFile = false;
  } catch {
    throw new DecisionError('cache-write', 'Could not write the local predicate decision.');
  } finally {
    if (ownsTemporaryFile) await unlink(temporaryPath).catch(() => undefined);
  }
}

function validGatewayEndpoint(endpoint: string): boolean {
  const gatewayUrl = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/openai\/decisions$/u;
  return gatewayUrl.exec(endpoint)?.[0] === endpoint;
}

async function fetchDecision(
  request: PredicateRequest,
  key: string,
  ttl: number,
  token: string,
  fetcher: typeof globalThis.fetch,
): Promise<number> {
  if (!validGatewayEndpoint(request.endpoint)) {
    throw new DecisionError('invalid-request', 'Remote mode requires an HTTPS Cloudflare AI Gateway OpenAI Decisions endpoint.');
  }
  let response: Response;
  try {
    response = await fetcher(request.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${token}`,
        'cf-aig-cache-key': `decision-v1-${key}`,
        'cf-aig-cache-ttl': `${ttl}`,
        'cf-aig-skip-cache': 'false',
      },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        questions: [{ type: 'predicate', name: request.name, instructions: request.instructions }],
      }),
    });
  } catch {
    throw new DecisionError('network', 'The predicate request did not complete.');
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    throw new DecisionError('http', 'The gateway did not return a successful predicate response.', response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DecisionError('invalid-response', 'The gateway predicate response is not valid JSON.');
  }
  if (isRecord(payload) && (payload.error === undefined || payload.error === null) &&
    payload.model === request.model && Array.isArray(payload.answers) && payload.answers.length === 1) {
    const answer: unknown = payload.answers[0];
    if (isRecord(answer) && answer.type === 'predicate' && answer.name === request.name && isProbability(answer.probability)) {
      return answer.probability;
    }
  }
  throw new DecisionError('invalid-response', 'The gateway response does not match the requested predicate.');
}

export function createDecisionClient(options: DecisionClientOptions): DecisionClient {
  const ttl = options.ttlSeconds;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 2_592_000) {
    throw new DecisionError('invalid-configuration', 'ttlSeconds must be an integer from 60 to 2592000.');
  }
  if (typeof options.cacheDir !== 'string' || options.cacheDir.length === 0 || options.cacheDir.includes('\0')) {
    throw new DecisionError('invalid-configuration', 'A caller-private cache directory is required.');
  }
  const dir = resolve(options.cacheDir);
  const remote = options.mode === 'remote'
    ? { token: options.token, fetcher: options.fetch ?? globalThis.fetch }
    : undefined;
  if (remote && (typeof remote.token !== 'string' || remote.token.length === 0 || /[^\x21-\x7E]/u.test(remote.token))) {
    throw new DecisionError('invalid-configuration', 'Remote mode requires a valid gateway token.');
  }

  return {
    lookup(request) {
      const key = predicateKey(request);
      return readCache(join(dir, `${key}.json`), key, ttl);
    },
    async resolve(request) {
      const { scope, endpoint, model, name, instructions, input } = request;
      const snapshot = { scope, endpoint, model, name, instructions, input };
      const key = predicateKey(snapshot);
      const path = join(dir, `${key}.json`);
      try {
        return readCache(path, key, ttl);
      } catch (error) {
        if (!remote || !(error instanceof DecisionError) || error.code !== 'cache-miss') throw error;
      }
      const probability = await fetchDecision(snapshot, key, ttl, remote.token, remote.fetcher);
      await writeCache(dir, path, key, ttl, probability);
      return probability;
    },
  };
}
