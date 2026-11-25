# Decision Kit

Decision Kit resolves a named predicate to a probability through an explicitly configured Cloudflare AI Gateway.
It supports OpenAI Decisions predicates and Jev Noul questions on the universal Workers AI route.
The MoonBit and TypeScript libraries share a request contract and a local cache format.
Applications decide how to interpret the probability, including when to abstain.
This repository does not implement a linter or install a command-line tool.

## Predicate v1

A request has six strings: the credential scope, endpoint URL, model ID, predicate name, instructions, and input text.
A Jev request also identifies the Gateway separately and uses the model alias `typesafe/jev`.
The required, nonblank scope identifies the caller's authorization boundary without storing a secret.
Change it when the tenant, credential permissions, or model deployment changes.
Source code is input data, not instructions.
Cache-only lookup must never send the input or contact a provider.
An online cache miss may send the complete input only when the host explicitly opts in.
Network failures, malformed responses, and cache misses are not a probability of zero.

| Protocol         | Cloudflare endpoint                                                     | Authentication and routing              |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| OpenAI Decisions | `https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/openai/decisions` | `cf-aig-authorization`                  |
| Jev Noul         | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/run`          | `Authorization` and `cf-aig-gateway-id` |

Both routes opt in to Gateway caching with `cf-aig-cache-key`, `cf-aig-cache-ttl`, and `cf-aig-skip-cache: false`.
The local cache remains separate from Gateway caching.
An option to disable Gateway caching is future work tracked in Projektor as `DCKIT-1`.

### Interoperable cache

1. For OpenAI, frame the strings `decision-kit/predicate/v1`, `scope`, `endpoint`, `model`, `name`, `instructions`, and `input` in that order.
   For Jev, frame `decision-kit/predicate/jev/v1`, `scope`, `endpoint`, `gatewayId`, `model`, `name`, `instructions`, and `input`.
2. Encode each string as UTF-8 and prepend its byte length in decimal ASCII and a colon.
3. Concatenate the frames without a separator and compute the lowercase hexadecimal SHA-256 digest.
4. In a caller-owned private directory, use `<digest>.json` as the cache slot.

The [OpenAI fixture](fixtures/predicate-v1.json) and [Jev fixture](fixtures/jev-predicate-v1.json) fix the expected Unicode digests independently of either language binding.
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
The repository validates both bindings without publishing packages to npm or Mooncakes.
