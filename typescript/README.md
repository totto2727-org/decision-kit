# Decision Kit for Node.js

Decision Kit resolves a single OpenAI Decisions predicate or Jev Noul through a direct service endpoint, Cloudflare AI Gateway, or a trusted proxy.
Each route returns a probability that application code can interpret.
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
Supply a bearer token authorized for the route you select.

```ts
const token = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY
if (!token) throw new Error('Configure a Cloudflare token for the selected route.')
const remote = createDecisionClient({ cacheDir, ttlSeconds: 3600, mode: 'remote', token })
const probability = await Effect.runPromise(remote.resolve(openai))
```

### Endpoints and credentials

Set `request.endpoint` to the complete POST URL, including its path.
Decision Kit does not append a provider path.
The standard routes below do not require a separate `endpoint` in the client options.

| Protocol            | Standard URL                                                            | Request settings                                                                                                         | Bearer header                            |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| OpenAI Decisions    | `https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/openai/decisions` | Omit `provider` or set `provider: 'openai-decisions'`.                                                                   | `cf-aig-authorization`                   |
| OpenAI Decisions    | `https://api.openai.com/v1/decisions`                                   | Omit `provider` or set `provider: 'openai-decisions'`.                                                                   | `Authorization`                          |
| Workers AI Jev      | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/run`          | Set `provider: 'jev'`, `model: 'typesafe/jev'`, and `gatewayId`.                                                         | `Authorization` with `cf-aig-gateway-id` |
| TypeSafe System One | `https://api.typesafe.ai/v1/systemone`                                  | Set `provider: 'jev'` and `model: 'jev-latest'`, `'jev-preview'`, or a version such as `'jev-1.14.0'`. Omit `gatewayId`. | `Authorization`                          |

For any other URL, pass the trusted complete URL as `endpoint` to `createDecisionClient` as well as in the request.
Set the client's endpoint from trusted application configuration, not from an untrusted request.
When a client has a pinned endpoint, the request URL must match it exactly, even for a standard route.
Use a lowercase ASCII DNS hostname, an optional port, and a slash-prefixed path.
Pinned URLs cannot include IP literals, user information, query strings, fragments, whitespace, percent escapes, doubled slashes, or `.` and `..` path segments.
Use a separate pinned client for each credential when requests can select endpoints.
Remote resolution never follows redirects or switches providers or models after failure.

For a provider-native `https://gateway.ai.cloudflare.com/` route using a stored provider key, set `token` to the Cloudflare Gateway token.
Decision Kit sends it in `cf-aig-authorization`.
If the route requires a separate provider key, set `token` to the provider key and `gatewayToken` to the Cloudflare Gateway token.
Decision Kit sends both `Authorization` and `cf-aig-authorization` only to the provider-native Cloudflare authority.
See [Cloudflare AI Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/index.md).

This example sends a System One request through a trusted proxy with a custom path.

```ts
const endpoint = 'https://decisions.example.com/custom/jev'
const jev = {
  ...openai,
  provider: 'jev',
  endpoint,
  model: 'jev-latest',
} satisfies PredicateRequest

const token = process.env.TYPESAFE_API_KEY
if (!token) throw new Error('Configure a token for the TypeSafe route.')
const remote = createDecisionClient({ cacheDir, endpoint, ttlSeconds: 3600, mode: 'remote', token })
const probability = await Effect.runPromise(remote.resolve(jev))
```

### Cache controls

Use a private cache directory and a nonsecret `scope` that separates authorization contexts that must not share decisions.
Update the scope when effective authorization changes, not when an equivalent token rotates.
Remote resolution sends the question and input to the endpoint only on a local miss.
Set `remoteCache: 'cloudflare'` to send `cf-aig-cache-key`, `cf-aig-cache-ttl`, and `cf-aig-skip-cache`.
Set `remoteCache: 'none'` to omit these headers.
If omitted, the policy is `'cloudflare'` for the standard Cloudflare routes and `'none'` for direct and custom endpoints.
This option does not change authentication, the local cache key, or local cache behavior.

`predicateKey(request)` returns the lowercase SHA-256 v1 digest shared with MoonBit.
The OpenAI digest retains its original framing.
The Workers AI Jev digest retains its own domain tag and includes `gatewayId` after `endpoint`.
System One Jev uses a separate domain tag and does not include a Gateway ID.
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
