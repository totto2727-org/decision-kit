# Decision Kit

Decision Kit resolves a named predicate to a probability using OpenAI Decisions or Jev Noul.
It can call a provider directly or POST to a compatible HTTPS proxy, including Cloudflare AI Gateway.
The MoonBit and TypeScript libraries share a request contract and a local cache format.
Applications decide how to interpret the probability, including when to abstain.
This repository does not implement a linter or install a command-line tool.

## Predicate v1

A request has six strings: the credential scope, endpoint URL, model ID, predicate name, instructions, and input text.
For Jev through Workers AI, the request also identifies the Gateway separately and uses the model alias `typesafe/jev`.
The required, nonblank scope identifies the caller's authorization boundary without storing a secret.
Change it when the tenant, credential permissions, or model deployment changes.
Source code is input data, not instructions.
Cache-only lookup must never send the input or contact a provider.
An online cache miss may send the complete input only when the host explicitly opts in.
Network failures, malformed responses, and cache misses are not a probability of zero.

### Choose an endpoint and a remote cache policy

Supply the complete POST URL, not a base URL: the SDK does not append `/v1`, a provider name, or a method path.
Pin that exact URL on the remote client when using a custom proxy, so a request cannot redirect the client's credential to another destination.
The official direct endpoints and the original Cloudflare routes listed below work without a pin.
If request fields can come from outside your application, pin even an official URL so the caller cannot select a different provider or Gateway account for that credential.

| Wire format                                                                                        | Example endpoint                                                        | Authentication and routing                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| [OpenAI Decisions](https://developers.openai.com/api/reference/resources/decisions/methods/create) | `https://api.openai.com/v1/decisions`                                   | `Authorization: Bearer …`                                     |
| OpenAI Decisions through Cloudflare                                                                | `https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/openai/decisions` | `cf-aig-authorization` (Gateway-managed provider credentials) |
| [TypeSafe System One](https://docs.typesafe.ai/go/api.md)                                          | `https://api.typesafe.ai/v1/systemone`                                  | `Authorization: Bearer …`                                     |
| Jev through Workers AI                                                                             | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/run`          | `Authorization` and `cf-aig-gateway-id`                       |

A transparent proxy accepts the same request body and returns the same response as the provider.
Workers AI is not a transparent proxy for System One: direct Jev takes `state` and `questions` at the top level and returns `answers`, whereas Workers AI wraps the input and the completed result.
Use Jev without a Gateway ID for the System One format and with a Gateway ID for the Workers AI format.

For a provider-native proxy on `gateway.ai.cloudflare.com`, the default token authenticates the Gateway, which can supply a stored provider key.
If you supply the provider key yourself, pass it as `token` and the separate Gateway credential as `gatewayToken` (MoonBit: `gateway_token`).
The SDK sends the second credential only to the provider-native Cloudflare authority, not to a direct API or another proxy.
See [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) for the distinction between the two authorization headers.

Set `remoteCache: 'cloudflare'` on the TypeScript remote client, or `remote_cache=Cloudflare` in MoonBit, to send `cf-aig-cache-key`, `cf-aig-cache-ttl`, and `cf-aig-skip-cache: false`.
Select `none` to omit all three headers and leave caching to the server; this does not suppress authentication or routing headers.
When the setting is omitted, the two original Cloudflare routes retain their cache headers and direct or custom endpoints omit them.
Changing this setting neither disables the local disk cache nor changes its key.

### Interoperable cache

1. For OpenAI, frame the strings `decision-kit/predicate/v1`, `scope`, `endpoint`, `model`, `name`, `instructions`, and `input` in that order.
   For Jev through Workers AI, frame `decision-kit/predicate/jev/v1`, `scope`, `endpoint`, `gatewayId`, `model`, `name`, `instructions`, and `input`.
   For Jev System One, use `decision-kit/predicate/jev-systemone/v1`, `scope`, `endpoint`, `model`, `name`, `instructions`, and `input`.
2. Encode each string as UTF-8 and prepend its byte length in decimal ASCII and a colon.
3. Concatenate the frames without a separator and compute the lowercase hexadecimal SHA-256 digest.
4. In a caller-owned private directory, use `<digest>.json` as the cache slot.

The [OpenAI](fixtures/predicate-v1.json), [Workers AI](fixtures/jev-predicate-v1.json), and [System One](fixtures/jev-systemone-v1.json) fixtures fix the expected Unicode digests independently of either language binding.
Each entry contains `version: 1`, `key`, `createdAt`, `expiresAt`, and `probability`.
Timestamps are integer Unix seconds and the probability must be a finite number in `[0, 1]`.
An entry is usable only when the version and expected key match and `createdAt <= now < min(expiresAt, createdAt + requestedTTL)`.
The TTL is between 60 and 2592000 seconds.
Changing the provider, model, question, instructions, state, endpoint, Gateway, or scope selects a different entry.
Do not store source, questions, credentials, raw responses, or failures in these files.
Treat the cache as trusted local input: a hash in a filename does not authenticate whoever wrote the file.

## Lint integration

Keep deterministic AST rules in the linter.
For a semantic rule, select evidence in code, resolve a predicate in an explicit preflight step, and pass the result to the synchronous rule callback.
Do not invoke the network on every visited AST node or silently treat a cache miss as a clean check.
Do not use model judgments for automatic source rewrites.
`mbtlint` and Oxlint can remain fully usable without Decision Kit, a credential, or a network connection.

See [MoonBit](moonbit/) and [TypeScript](typescript/) for the two bindings.
The TypeScript library exposes lazy `lookup` and `resolve` effects with typed failures and an explicit `lookupSync` adapter for synchronous visitors.
The [mbtlint example](examples/mbtlint/) and [Oxlint plugin](typescript/examples/oxlint/) use cache-only rule evaluation and never send source code to a provider.

## Development

See [AGENTS.md](AGENTS.md) for the local toolchains and verification commands.
Pull requests validate both bindings without publishing.
On pushes to `main`, the [publish workflow](.github/workflows/publish.yml) releases `@totto2727/decision-kit` to npm and `totto2727/decision-kit` to Mooncakes.
