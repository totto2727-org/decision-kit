# Decision Kit

Decision Kit resolves a named predicate to a probability using OpenAI Decisions through an explicitly configured Cloudflare AI Gateway.
The MoonBit and TypeScript libraries share a request contract and a local cache format.
Applications decide how to interpret the probability, including when to abstain.
This repository does not implement a linter or install a command-line tool.

## Predicate v1

A request has six strings: the credential scope, endpoint URL, model ID, predicate name, instructions, and input text.
The required, nonblank scope identifies the caller's authorization boundary without storing a secret.
Change it when the tenant, credential permissions, or model deployment changes.
Source code is input data, not instructions.
Cache-only lookup must never send the input or contact a provider.
An online cache miss may send the complete input only when the host explicitly opts in.
Network failures, malformed responses, and cache misses are not a probability of zero.

### Interoperable cache

1. In order, frame the strings `decision-kit/predicate/v1`, `scope`, `endpoint`, `model`, `name`, `instructions`, and `input`.
2. Encode each string as UTF-8 and prepend its byte length in decimal ASCII and a colon.
3. Concatenate the frames without a separator and compute the lowercase hexadecimal SHA-256 digest.
4. In a caller-owned private directory, use `<digest>.json` as the cache slot.

The [Unicode fixture](fixtures/predicate-v1.json) fixes the expected digest independently of either language binding.
Each entry contains `version: 1`, `key`, `createdAt`, `expiresAt`, and `probability`.
Timestamps are integer Unix seconds and the probability must be a finite number in `[0, 1]`.
An entry is usable only when the version and expected key match and `createdAt <= now < min(expiresAt, createdAt + requestedTTL)`.
The TTL is between 60 and 2592000 seconds.
Changing the model, question, instructions, state, endpoint or scope selects a different entry.
Do not store source, questions, credentials, raw responses, or failures in these files.
Treat the cache as trusted local input: a hash in a filename does not authenticate whoever wrote the file.

## Lint integration

Keep deterministic AST rules in the linter.
For a semantic rule, select evidence in code, resolve a predicate in an explicit preflight step, and pass the result to the synchronous rule callback.
Do not invoke the network on every visited AST node or silently treat a cache miss as a clean check.
Do not use model judgments for automatic source rewrites.
`mbtlint` and Oxlint can remain fully usable without Decision Kit, a credential, or a network connection.

See [MoonBit](moonbit/) and [TypeScript](typescript/) for the two bindings.
The [mbtlint example](examples/mbtlint/) and [Oxlint plugin](typescript/examples/oxlint/) use cache-only rule evaluation and never send source code to a provider.
