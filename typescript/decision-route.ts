import { Predicate, Result, Schema } from 'effect'

import { BearerToken, decisionError, RemoteCachePolicy } from './decision-contract.ts'
import type { DecisionError, PredicateRequest, RemoteOptions } from './decision-contract.ts'
import type { CacheSlot } from './predicate-cache.ts'

const OpenAIGatewayEndpoint =
  /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/openai\/decisions(?![\s\S])/u
const WorkersEndpoint = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[A-Za-z0-9_-]+\/ai\/run(?![\s\S])/u
const ProviderGatewayAuthority = 'https://gateway.ai.cloudflare.com/'
const OpenAIDirectEndpoint = 'https://api.openai.com/v1/decisions'
const SystemOneEndpoint = 'https://api.typesafe.ai/v1/systemone'
const Endpoint = /^https:\/\/(?<host>[a-z0-9.-]+)(?::(?<port>[1-9][0-9]{0,4}))?(?<path>\/[A-Za-z0-9._~/-]*)(?![\s\S])/u
const DnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const DnsFinalLabel = /^[a-z]/u
const MaxHostLength = 253
const MaxPort = 65_535
const FinalLabelIndex = -1

const isSafeDnsHost = (host: string): boolean => {
  const labels = host.split('.')
  return (
    host.length <= MaxHostLength &&
    labels.every((label) => DnsLabel.test(label)) &&
    DnsFinalLabel.test(labels.at(FinalLabelIndex) ?? '')
  )
}

const isSafeEndpoint = (endpoint: string): boolean => {
  const { host, port, path } = Endpoint.exec(endpoint)?.groups ?? {}
  if (Predicate.isNullish(host) || Predicate.isNullish(path) || Number(port ?? '0') > MaxPort || !isSafeDnsHost(host)) {
    return false
  }
  if (path.includes('//') || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return false
  }
  const url = URL.parse(endpoint)
  return Predicate.isNotNullish(url) && url.hostname === host && url.pathname === path
}

const SafeEndpoint = Schema.String.check(Schema.makeFilter(isSafeEndpoint))
const isRemoteSettings = Schema.is(
  Schema.Struct({
    endpoint: Schema.optional(SafeEndpoint),
    gatewayToken: Schema.optional(BearerToken),
    remoteCache: Schema.optional(RemoteCachePolicy),
  }),
)

const isCanonicalGateway = (request: PredicateRequest): boolean => {
  if (request.provider !== 'jev') {
    return OpenAIGatewayEndpoint.test(request.endpoint)
  }
  return Predicate.isNotNullish(request.gatewayId) && WorkersEndpoint.test(request.endpoint)
}

const isOfficialDirectEndpoint = (request: PredicateRequest): boolean => {
  if (request.provider !== 'jev') {
    return request.endpoint === OpenAIDirectEndpoint
  }
  return Predicate.isNullish(request.gatewayId) && request.endpoint === SystemOneEndpoint
}

const authHeaders = (request: PredicateRequest, { gatewayToken, token }: RemoteOptions): Record<string, string> => {
  const bearer = `Bearer ${token}`
  const additional = Predicate.isNullish(gatewayToken) ? {} : { 'cf-aig-authorization': `Bearer ${gatewayToken}` }
  if (request.provider === 'jev' && Predicate.isNotNullish(request.gatewayId)) {
    return { authorization: bearer, 'cf-aig-gateway-id': request.gatewayId, ...additional }
  }
  if (Predicate.isNullish(gatewayToken) && request.endpoint.startsWith(ProviderGatewayAuthority)) {
    return { 'cf-aig-authorization': bearer }
  }
  return { authorization: bearer, ...additional }
}

const authorizeRoute = (
  request: PredicateRequest,
  options: RemoteOptions,
  canonical: boolean,
): Result.Result<Record<string, string>, DecisionError> => {
  const { endpoint, gatewayToken } = options
  if (!isRemoteSettings(options)) {
    return Result.fail(
      decisionError('invalid-configuration', 'The trusted endpoint, gatewayToken, or remoteCache is invalid.'),
    )
  }
  if (
    Predicate.isNullish(endpoint) ? !canonical && !isOfficialDirectEndpoint(request) : request.endpoint !== endpoint
  ) {
    return Result.fail(decisionError('invalid-request', 'The request endpoint does not match a trusted remote route.'))
  }
  if (Predicate.isNotNullish(gatewayToken) && !request.endpoint.startsWith(ProviderGatewayAuthority)) {
    return Result.fail(
      decisionError('invalid-configuration', 'gatewayToken requires a provider-native Cloudflare AI Gateway endpoint.'),
    )
  }
  return Result.succeed(authHeaders(request, options))
}

export const remoteHeaders = (
  request: PredicateRequest,
  options: RemoteOptions,
  slot: CacheSlot,
): Result.Result<Record<string, string>, DecisionError> => {
  const canonical = isCanonicalGateway(request)
  const useCloudflareCache = (options.remoteCache ?? (canonical ? 'cloudflare' : 'none')) === 'cloudflare'
  return Result.map(authorizeRoute(request, options, canonical), (auth) => ({
    ...auth,
    ...(useCloudflareCache && {
      'cf-aig-cache-key': `decision-v1-${slot.key}`,
      'cf-aig-cache-ttl': `${slot.ttl}`,
      'cf-aig-skip-cache': 'false',
    }),
  }))
}
