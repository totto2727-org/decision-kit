// oxlint-disable-next-line rules/no-node-imports -- The cache key is synchronous for host lint visitors.
import { createHash, randomUUID } from 'node:crypto'
// oxlint-disable-next-line rules/no-node-imports -- Oxlint rule visitors cannot suspend while reading the cache.
import { readFileSync } from 'node:fs'
// oxlint-disable-next-line rules/no-node-imports -- Exclusive open modes and atomic replacement protect shared cache files.
import { mkdir, open, rename, unlink } from 'node:fs/promises'
// oxlint-disable-next-line rules/no-node-imports -- Resolve cache files using Node host path semantics.
import Path from 'node:path'

import { Clock, Effect, Schema } from 'effect'

import { decisionError, Probability } from './decision-contract.ts'
import type { Decision, DecisionError, PredicateRequest } from './decision-contract.ts'

const MillisPerSecond = 1000
const PrivateDirectory = 0o700
const PrivateFile = 0o600
const CacheVersion = 1
const nowSeconds = Clock.currentTimeMillis.pipe(Effect.map((ms) => Math.floor(ms / MillisPerSecond)))
const CacheRecord = Schema.Struct({
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
  key: Schema.String,
  probability: Probability,
  version: Schema.Literal(CacheVersion),
})
const decodeCache = Schema.decodeEffect(Schema.fromJsonString(CacheRecord))
const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))
const utf8 = new TextDecoder('utf-8', { fatal: true })

export const hashRequest = (request: PredicateRequest): string => {
  const { scope, endpoint, model, name, instructions, input } = request
  const fields =
    request.provider === 'jev'
      ? ['decision-kit/predicate/jev/v1', scope, endpoint, request.gatewayId, model, name, instructions, input]
      : ['decision-kit/predicate/v1', scope, endpoint, model, name, instructions, input]
  const hash = createHash('sha256')
  fields.forEach((field) => {
    hash.update(`${Buffer.byteLength(field, 'utf8')}:`, 'ascii')
    hash.update(field, 'utf8')
  })
  return hash.digest('hex')
}

export type CacheSlot = Readonly<{ dir: string; key: string; path: string; ttl: number }>

export const cacheSlot = (cacheDir: string, ttl: number, request: PredicateRequest): CacheSlot => {
  const key = hashRequest(request)
  const dir = Path.resolve(cacheDir)
  return { dir, key, path: Path.join(dir, `${key}.json`), ttl }
}

const readCacheText = (path: string): Effect.Effect<string, DecisionError> =>
  Effect.gen(function* () {
    const bytes = yield* Effect.try({
      catch: (cause) =>
        isMissingFile(cause)
          ? decisionError('cache-miss', 'No local predicate decision for this request.')
          : decisionError('cache-read', 'Could not read the local predicate decision.'),
      // oxlint-disable-next-line node/no-sync -- This is the cache-only lookup used in synchronous lint visitors.
      try: () => readFileSync(path),
    })
    return yield* Effect.try({
      catch: () => decisionError('cache-invalid', 'Local predicate decision is not valid UTF-8.'),
      try: () => utf8.decode(bytes),
    })
  })

export const readCache = ({ path, key, ttl }: CacheSlot): Decision =>
  Effect.gen(function* () {
    const text = yield* readCacheText(path)
    const record = yield* decodeCache(text).pipe(
      Effect.mapError(() =>
        decisionError('cache-invalid', 'Local predicate decision does not match the v1 cache contract.'),
      ),
    )
    if (record.key !== key) {
      return yield* Effect.fail(
        decisionError('cache-invalid', 'Local predicate decision does not match the requested key.'),
      )
    }
    const now = yield* nowSeconds
    if (record.createdAt > now || now >= record.expiresAt || now - record.createdAt >= ttl) {
      return yield* Effect.fail(
        decisionError('cache-miss', 'Local predicate decision is outside its freshness window.'),
      )
    }
    return record.probability
  })

const writeRecord = async (slot: CacheSlot, record: typeof CacheRecord.Type): Promise<void> => {
  const temporaryPath = Path.join(slot.dir, `.${record.key}.${randomUUID()}.tmp`)
  await mkdir(slot.dir, { mode: PrivateDirectory, recursive: true })
  const file = await open(temporaryPath, 'wx', PrivateFile)
  try {
    try {
      await file.writeFile(JSON.stringify(record), 'utf8')
    } finally {
      await file.close()
    }
    await rename(temporaryPath, slot.path)
  } finally {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary path no longer exists after a successful rename.
    }
  }
}

export const writeCache = (slot: CacheSlot, probability: number): Effect.Effect<void, DecisionError> =>
  nowSeconds.pipe(
    Effect.flatMap((createdAt) =>
      Effect.tryPromise({
        catch: () => decisionError('cache-write', 'Could not write the local predicate decision.'),
        try: async () =>
          writeRecord(slot, {
            createdAt,
            expiresAt: createdAt + slot.ttl,
            key: slot.key,
            probability,
            version: CacheVersion,
          }),
      }).pipe(Effect.uninterruptible),
    ),
  )
