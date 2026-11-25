import { Effect, Predicate, Result, Schema } from 'effect'

import { decisionError, parseRequest } from './decision-contract.ts'
import type {
  Decision,
  DecisionClient,
  DecisionClientOptions,
  DecisionError,
  PredicateRequest,
  RemoteOptions,
} from './decision-contract.ts'
import { fetchDecision } from './gateway-predicate.ts'
import { cacheSlot, hashRequest, readCache, writeCache } from './predicate-cache.ts'
import type { CacheSlot } from './predicate-cache.ts'

export { DecisionError } from './decision-contract.ts'
export type { DecisionClient, DecisionClientOptions, DecisionErrorCode, PredicateRequest } from './decision-contract.ts'

const Ttl = Schema.Int.check(Schema.isBetween({ maximum: 2_592_000, minimum: 60 }))
const CacheDirectory = Schema.NonEmptyString.check(Schema.makeFilter((value: string) => !value.includes('\0')))
const Token = Schema.String.check(Schema.isPattern(/^[\u0021-\u007E]+(?![\s\S])/u))
const isTtl = Schema.is(Ttl)
const isCacheDirectory = Schema.is(CacheDirectory)
const isToken = Schema.is(Token)

type OpenDecision = Readonly<{ remote: RemoteOptions | undefined; slot: CacheSlot; snapshot: PredicateRequest }>

const validateOptions = (options: DecisionClientOptions): Effect.Effect<DecisionClientOptions, DecisionError> => {
  if (!isTtl(options.ttlSeconds)) {
    return Effect.fail(decisionError('invalid-configuration', 'ttlSeconds must be an integer from 60 to 2592000.'))
  }
  if (!isCacheDirectory(options.cacheDir)) {
    return Effect.fail(decisionError('invalid-configuration', 'A caller-private cache directory is required.'))
  }
  if (options.mode === 'remote' && !isToken(options.token)) {
    return Effect.fail(decisionError('invalid-configuration', 'Remote mode requires a valid gateway token.'))
  }
  return Effect.succeed(options)
}

const openDecision = (
  options: DecisionClientOptions,
  request: PredicateRequest,
): Effect.Effect<OpenDecision, DecisionError> =>
  Effect.gen(function* () {
    const { cacheDir, ttlSeconds } = yield* validateOptions(options)
    const parsed = parseRequest(request)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(parsed.failure)
    }
    const snapshot = parsed.success
    const remote = options.mode === 'remote' ? options : undefined
    return { remote, slot: cacheSlot(cacheDir, ttlSeconds, snapshot), snapshot }
  })

const resolveOnMiss = ({ remote, slot, snapshot }: OpenDecision): Decision =>
  Effect.matchEffect(readCache(slot), {
    onFailure: (error) => {
      if (Predicate.isNullish(remote) || error.code !== 'cache-miss') {
        return Effect.fail(error)
      }
      return fetchDecision(snapshot, remote, slot).pipe(Effect.tap((probability) => writeCache(slot, probability)))
    },
    onSuccess: Effect.succeed,
  })

export const createDecisionClient = (options: DecisionClientOptions): DecisionClient => {
  const settings = { ...options }
  return {
    lookup: (request) => openDecision(settings, request).pipe(Effect.flatMap(({ slot }) => readCache(slot))),
    resolve: (request) => openDecision(settings, request).pipe(Effect.flatMap(resolveOnMiss)),
  }
}

/**
 * Compute the provider-specific v1 SHA-256 digest.
 * @param {PredicateRequest} request The predicate request.
 * @returns {string} The lowercase hexadecimal digest.
 */
export const predicateKey = (request: PredicateRequest): string => {
  const parsed = parseRequest(request)
  if (Result.isFailure(parsed)) {
    throw parsed.failure
  }
  return hashRequest(parsed.success)
}

/**
 * Execute only the synchronous, cache-only lookup for hosts such as Oxlint.
 * @param {DecisionClient} client A Decision Kit client.
 * @param {PredicateRequest} request The predicate to look up.
 * @returns {Result.Result<number, DecisionError>} A cached probability or a typed failure.
 */
export const lookupSync = (client: DecisionClient, request: PredicateRequest): Result.Result<number, DecisionError> =>
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Oxlint rule visitors cannot suspend.
  Effect.runSync(Effect.result(client.lookup(request)))
