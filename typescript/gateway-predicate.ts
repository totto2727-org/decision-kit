import { Effect, Option, Predicate, Schema } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { DecisionError, decisionError, Probability } from './decision-contract.ts'
import type { Decision, PredicateRequest, RemoteOptions } from './decision-contract.ts'
import type { CacheSlot } from './predicate-cache.ts'

const OpenAIEndpoint =
  /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/openai\/decisions(?![\s\S])/u
const JevEndpoint = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[A-Za-z0-9_-]+\/ai\/run(?![\s\S])/u
const OpenAIAnswer = Schema.Struct({ name: Schema.String, probability: Probability, type: Schema.Literal('predicate') })
const OpenAIResponse = Schema.Struct({
  answers: Schema.Tuple([OpenAIAnswer]),
  error: Schema.optionalKey(Schema.Null),
  model: Schema.String,
})
const Noul = Schema.Struct({ noul: Probability, type: Schema.Literal('noul') })
const JevModel = Schema.String.check(Schema.isPattern(/^jev-\d+\.\d+\.\d+(?![\s\S])/u))
const JevResult = Schema.Struct({ answers: Schema.Record(Schema.String, Noul), model: JevModel })
const JevResponse = Schema.Struct({
  result: Schema.Struct({ result: JevResult, state: Schema.Literal('Completed') }),
  success: Schema.Literal(true),
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Gateway JSON has not crossed its schema boundary yet.
const decodeOpenAI = Schema.decodeUnknownEffect(OpenAIResponse)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Gateway JSON has not crossed its schema boundary yet.
const decodeJev = Schema.decodeUnknownEffect(JevResponse)

const invalidResponse = (): DecisionError =>
  decisionError('invalid-response', 'The gateway response does not match the requested predicate.')

const networkError = (): DecisionError => decisionError('network', 'The predicate request did not complete.')

const normalizeJev = (name: string, payload: unknown): Decision =>
  Effect.gen(function* () {
    const response = yield* decodeJev(payload).pipe(Effect.mapError(invalidResponse))
    const [first, second] = Object.entries(response.result.result.answers)
    if (Predicate.isNullish(first) || Predicate.isNotNullish(second) || first[0] !== name) {
      return yield* Effect.fail(invalidResponse())
    }
    return first[1].noul
  })

const normalizeOpenAI = (request: PredicateRequest, payload: unknown): Decision =>
  Effect.gen(function* () {
    const response = yield* decodeOpenAI(payload).pipe(Effect.mapError(invalidResponse))
    const [answer] = response.answers
    if (response.model !== request.model || answer.name !== request.name) {
      return yield* Effect.fail(invalidResponse())
    }
    return answer.probability
  })

const requestBody = (request: PredicateRequest): string => {
  const { input, instructions, model, name } = request
  if (request.provider === 'jev') {
    const questions = { [name]: { instructions, type: 'noul' } }
    return JSON.stringify({ input: { questions, state: input }, model })
  }
  return JSON.stringify({ input, model, questions: [{ instructions, name, type: 'predicate' }] })
}

const prepareRequest = (
  request: PredicateRequest,
  token: string,
  slot: CacheSlot,
): Effect.Effect<HttpClientRequest.HttpClientRequest, DecisionError> => {
  const isJev = request.provider === 'jev'
  if (!(isJev ? JevEndpoint : OpenAIEndpoint).test(request.endpoint)) {
    return Effect.fail(
      decisionError(
        'invalid-request',
        'Remote mode requires the official HTTPS Cloudflare endpoint for the selected provider.',
      ),
    )
  }
  const headers = {
    'cf-aig-cache-key': `decision-v1-${slot.key}`,
    'cf-aig-cache-ttl': `${slot.ttl}`,
    'cf-aig-skip-cache': 'false',
    ...(isJev
      ? { authorization: `Bearer ${token}`, 'cf-aig-gateway-id': request.gatewayId }
      : { 'cf-aig-authorization': `Bearer ${token}` }),
  }
  const body = requestBody(request)
  const wire = HttpClientRequest.post(request.endpoint, { headers })
  return Effect.succeed(HttpClientRequest.bodyText(wire, body, 'application/json'))
}

const failHttp = (message: Response): Decision => {
  const error = new DecisionError({
    cause: undefined,
    code: 'http',
    message: 'The gateway did not return a successful predicate response.',
    status: message.status,
  })
  const discard = Effect.tryPromise({ catch: invalidResponse, try: async () => message.body?.cancel() })
  return discard.pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
}

const readResponse = (request: PredicateRequest, response: HttpClientResponse.HttpClientResponse): Decision => {
  const web = HttpClientResponse.toWeb(response)
  if (Option.isNone(web)) {
    return Effect.fail(invalidResponse())
  }
  const message = web.value
  if (!message.ok || message.redirected) {
    return failHttp(message)
  }
  const json = Effect.tryPromise({
    catch: () => decisionError('invalid-response', 'The gateway predicate response is not valid JSON.'),
    try: async (): Promise<unknown> => message.json(),
  })
  return json.pipe(
    Effect.flatMap((payload) =>
      request.provider === 'jev' ? normalizeJev(request.name, payload) : normalizeOpenAI(request, payload),
    ),
  )
}

export const fetchDecision = (request: PredicateRequest, options: RemoteOptions, slot: CacheSlot): Decision => {
  const run = Effect.gen(function* () {
    const wire = yield* prepareRequest(request, options.token, slot)
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const response = yield* client.execute(wire).pipe(Effect.mapError(networkError))
    return yield* readResponse(request, response)
  }).pipe(
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, 'cf-aig-authorization']),
    Effect.timeoutOrElse({ duration: '90 seconds', orElse: () => Effect.fail(networkError()) }),
  )
  return Predicate.isNullish(options.fetch)
    ? run
    : run.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))
}
