import { Effect, Option, Predicate, Result, Schema } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { DecisionError, decisionError, JevRelease, JevSystemOneModel, Probability } from './decision-contract.ts'
import type { Decision, PredicateRequest, RemoteOptions } from './decision-contract.ts'
import { remoteHeaders } from './decision-route.ts'
import type { CacheSlot } from './predicate-cache.ts'

const OpenAIAnswer = Schema.Struct({ name: Schema.String, probability: Probability, type: Schema.Literal('predicate') })
const OpenAIResponse = Schema.Struct({
  answers: Schema.Tuple([OpenAIAnswer]),
  error: Schema.optionalKey(Schema.Null),
  model: Schema.String,
})
const Noul = Schema.Struct({ noul: Probability, type: Schema.Literal('noul') })
const NoulAnswers = Schema.Record(Schema.String, Noul)
const SystemOneJevResponse = Schema.Struct({
  answers: NoulAnswers,
  error: Schema.optionalKey(Schema.Null),
  model: JevSystemOneModel,
})
const WorkersJevResponse = Schema.Struct({
  result: Schema.Struct({
    result: Schema.Struct({ answers: NoulAnswers, model: JevRelease }),
    state: Schema.Literal('Completed'),
  }),
  success: Schema.Literal(true),
})
const isJevRelease = Schema.is(JevRelease)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Gateway JSON has not crossed its schema boundary yet.
const decodeOpenAI = Schema.decodeUnknownEffect(OpenAIResponse)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Gateway JSON has not crossed its schema boundary yet.
const decodeWorkersJev = Schema.decodeUnknownEffect(WorkersJevResponse)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- System One JSON has not crossed its schema boundary yet.
const decodeSystemOneJev = Schema.decodeUnknownEffect(SystemOneJevResponse)

const invalidResponse = (): DecisionError =>
  decisionError('invalid-response', 'The remote response does not match the requested predicate.')

const networkError = (): DecisionError => decisionError('network', 'The predicate request did not complete.')

const normalizeNoul = (name: string, answers: typeof NoulAnswers.Type): Decision => {
  const [first, second] = Object.entries(answers)
  if (Predicate.isNullish(first) || Predicate.isNotNullish(second) || first[0] !== name) {
    return Effect.fail(invalidResponse())
  }
  return Effect.succeed(first[1].noul)
}

const normalizeJev = (request: Extract<PredicateRequest, { provider: 'jev' }>, payload: unknown): Decision =>
  Effect.gen(function* () {
    if (Predicate.isNotNullish(request.gatewayId)) {
      const response = yield* decodeWorkersJev(payload).pipe(Effect.mapError(invalidResponse))
      return yield* normalizeNoul(request.name, response.result.result.answers)
    }
    const { answers, model } = yield* decodeSystemOneJev(payload).pipe(Effect.mapError(invalidResponse))
    if (model !== request.model && (isJevRelease(request.model) || !isJevRelease(model))) {
      return yield* Effect.fail(invalidResponse())
    }
    return yield* normalizeNoul(request.name, answers)
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
    return Predicate.isNullish(request.gatewayId)
      ? JSON.stringify({ model, questions, state: input })
      : JSON.stringify({ input: { questions, state: input }, model })
  }
  return JSON.stringify({ input, model, questions: [{ instructions, name, type: 'predicate' }] })
}

const prepareRequest = (
  request: PredicateRequest,
  options: RemoteOptions,
  slot: CacheSlot,
): Effect.Effect<HttpClientRequest.HttpClientRequest, DecisionError> => {
  const headers = remoteHeaders(request, options, slot)
  if (Result.isFailure(headers)) {
    return Effect.fail(headers.failure)
  }
  const body = requestBody(request)
  const wire = HttpClientRequest.post(request.endpoint, { headers: headers.success })
  return Effect.succeed(HttpClientRequest.bodyText(wire, body, 'application/json'))
}

const failHttp = (message: Response): Decision => {
  const error = new DecisionError({
    cause: undefined,
    code: 'http',
    message: 'The remote endpoint did not return a successful predicate response.',
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
    catch: () => decisionError('invalid-response', 'The remote predicate response is not valid JSON.'),
    try: async (): Promise<unknown> => message.json(),
  })
  return json.pipe(
    Effect.flatMap((payload) =>
      request.provider === 'jev' ? normalizeJev(request, payload) : normalizeOpenAI(request, payload),
    ),
  )
}

export const fetchDecision = (request: PredicateRequest, options: RemoteOptions, slot: CacheSlot): Decision => {
  const run = Effect.gen(function* () {
    const wire = yield* prepareRequest(request, options, slot)
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
