import { Data, Result, Schema } from 'effect'
import type { Effect } from 'effect'

const Utf8String = Schema.String.check(Schema.makeFilter((value: string) => value.isWellFormed()))
const NonblankString = Utf8String.check(Schema.isPattern(/\S/u))
const GatewayId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+(?![\s\S])/u))
export const BearerToken = Schema.String.check(Schema.isPattern(/^[\u0021-\u007E]+(?![\s\S])/u))
const PredicateFields = {
  endpoint: Utf8String,
  input: Utf8String,
  instructions: Utf8String,
  name: Utf8String,
  scope: NonblankString,
}
const OpenAIRequest = Schema.Struct({
  ...PredicateFields,
  model: Utf8String,
  provider: Schema.optionalKey(Schema.Literal('openai-decisions')),
})
const WorkersJevRequest = Schema.Struct({
  ...PredicateFields,
  gatewayId: GatewayId,
  model: Schema.Literal('typesafe/jev'),
  provider: Schema.Literal('jev'),
})
export const JevRelease = Schema.TemplateLiteral(['jev-', Schema.String]).check(
  Schema.isPattern(/^jev-\d+\.\d+\.\d+(?![\s\S])/u),
)
export const JevSystemOneModel = Schema.Union([JevRelease, Schema.Literals(['jev-latest', 'jev-preview'])])
const SystemOneJevRequest = Schema.Struct({
  ...PredicateFields,
  gatewayId: Schema.optionalKey(Schema.Never),
  model: JevSystemOneModel,
  provider: Schema.Literal('jev'),
})
const PredicateRequestSchema = Schema.Union([OpenAIRequest, WorkersJevRequest, SystemOneJevRequest])
export type PredicateRequest = typeof PredicateRequestSchema.Type
const decodeRequest = Schema.decodeResult(PredicateRequestSchema)

export const Probability = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }))

export type DecisionErrorCode =
  | 'invalid-request'
  | 'invalid-configuration'
  | 'cache-miss'
  | 'cache-invalid'
  | 'cache-read'
  | 'cache-write'
  | 'network'
  | 'http'
  | 'invalid-response'

export class DecisionError extends Data.TaggedError('DecisionError')<{
  cause: undefined
  code: DecisionErrorCode
  message: string
  status?: number
}> {}

export const decisionError = (code: DecisionErrorCode, message: string): DecisionError =>
  new DecisionError({ cause: undefined, code, message })

export const parseRequest = (request: PredicateRequest): Result.Result<PredicateRequest, DecisionError> => {
  const parsed = decodeRequest(request)
  return Result.mapError(parsed, () =>
    decisionError(
      'invalid-request',
      'Predicate fields must be well-formed UTF-8 strings with a nonblank scope and valid provider settings.',
    ),
  )
}

export type Decision = Effect.Effect<number, DecisionError>
export const RemoteCachePolicy = Schema.Literals(['none', 'cloudflare'])
export type RemoteCache = typeof RemoteCachePolicy.Type
export type RemoteOptions = Readonly<{
  /** Pin a trusted, complete HTTPS endpoint for remote calls. */
  endpoint?: string
  fetch?: typeof globalThis.fetch
  /** Send separate Cloudflare and provider tokens to a provider-native Gateway route. */
  gatewayToken?: string
  mode: 'remote'
  /** Control only Cloudflare's remote cache headers, not the local cache. */
  remoteCache?: RemoteCache
  token: string
}>
type CacheOptions = Readonly<{ cacheDir: string; ttlSeconds: number }>
export type DecisionClientOptions = CacheOptions & (Readonly<{ mode?: 'cache-only' }> | RemoteOptions)

export interface DecisionClient {
  /** Read only local state, regardless of the configured mode. */
  lookup: (request: PredicateRequest) => Decision
  /** Read local state first and request a decision on a miss only in remote mode. */
  resolve: (request: PredicateRequest) => Decision
}
