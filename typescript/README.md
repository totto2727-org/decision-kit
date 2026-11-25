# Decision Kit for Node.js

Decision Kit resolves a single OpenAI Decisions predicate or Jev Noul through a configured Cloudflare AI Gateway.
Both routes return a probability that application code can interpret.
The library requires Node.js 24 or later and Effect 4.

```ts
import { createDecisionClient, type PredicateRequest } from '@totto2727/decision-kit'
import { Effect } from 'effect'

const openai = {
  endpoint: 'https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/openai/decisions',
  scope: 'team-a:lint-service',
  model: 'gpt-6-luna',
  name: 'accurate',
  instructions: 'Does the title describe what the test body asserts?',
  input: 'Title: returns the administrator role\nAssertion: expected role is viewer',
} satisfies PredicateRequest

const cacheDir = '/path/to/private/cache'
const client = createDecisionClient({ cacheDir, ttlSeconds: 3600 })
const lookup = client.lookup(openai)
const result = await Effect.runPromise(Effect.result(lookup))
```

Both `lookup(request)` and `resolve(request)` return a lazy `Effect.Effect<number, DecisionError>`.
Creating the effect does not read or write the cache and does not contact a provider.
The application decides when to execute the effect and how to handle its typed failure channel.
Missing, expired, or future-dated records fail with `code: 'cache-miss'`.
Malformed records and I/O failures have separate codes and are not silently overwritten.
Treat unavailable evidence differently from a low probability.

`lookup` is always cache-only, including on a client configured for remote resolution.
`resolve` is also cache-only by default.
To populate the cache, opt in with `mode: 'remote'` and run `resolve` outside the synchronous lint visitor.
Supply a token authorized for the route you select.

```ts
const token = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY
if (!token) throw new Error('Configure a Cloudflare token for the selected route.')
const remote = createDecisionClient({ cacheDir, ttlSeconds: 3600, mode: 'remote', token })
const probability = await Effect.runPromise(remote.resolve(openai))
```

OpenAI Decisions is selected by omitting `provider` or specifying `'openai-decisions'`.
To select Jev explicitly, set `provider: 'jev'`, `model: 'typesafe/jev'`, the universal Workers AI endpoint, and the Gateway ID.
The route uses a Workers AI `Authorization` header and `cf-aig-gateway-id`, not a direct TypeSafe request.

```ts
const jev = {
  ...openai,
  provider: 'jev',
  endpoint: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/run',
  gatewayId: 'GATEWAY',
  model: 'typesafe/jev',
} satisfies PredicateRequest

const probability = await Effect.runPromise(remote.resolve(jev))
```

Use a private cache directory and a nonsecret `scope` that separates authorization contexts that must not share decisions.
Update the scope when effective authorization changes, not when an equivalent token rotates.
Remote resolution sends the question and input to Cloudflare only on a local miss.
It rejects redirects and does not switch providers or models after failure.
Both routes send Gateway cache opt-in headers derived from the request identity and `ttlSeconds`.
A switch to disable Gateway caching is future work tracked in Projektor as `DCKIT-1`.

`predicateKey(request)` returns the lowercase SHA-256 v1 digest shared with MoonBit.
The OpenAI digest retains its original framing.
The Jev digest uses its own domain tag and includes `gatewayId` after `endpoint`.
See the [shared cache contract](../README.md#interoperable-cache) for the exact field order.
The TTL must be an integer from 60 to 2,592,000 seconds.
The cache stores only the version, key, timestamps, and probability.

## Synchronous Oxlint hosts

The [Oxlint example](examples/oxlint/) uses `lookupSync(client, request)`, which executes the cache-only effect and returns `Result.Result<number, DecisionError>` synchronously.
Its visitor reports suspected title mismatches and unavailable evidence separately.
Use the same request fields and source extraction for the process that populates the cache and the visitor that reads it.

Run the following commands at the repository root to verify the SDK with mock transports and the example with a real Oxlint process:

```sh
vp run test
vp run build
vp run test:oxlint
```

Set `OXLINT_BIN` to use a particular executable.
The tests do not make live requests.
