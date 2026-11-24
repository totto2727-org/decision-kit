# Decision Kit for Node.js

Decision Kit queries a single OpenAI Decisions predicate through a configured Cloudflare AI Gateway and caches its probability locally.
It requires Node.js 22.18 or later and has no runtime dependencies.

```ts
import { createDecisionClient, DecisionError } from '@totto2727/decision-kit';

const request = {
  endpoint: 'https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/openai/decisions',
  scope: 'team-a:lint-service',
  model: 'gpt-6-luna',
  name: 'accurate',
  instructions: 'Does the title describe what the test body asserts?',
  input: 'Title: returns the administrator role\nAssertion: expected role is viewer',
};

const cacheDir = '/path/to/private/cache';
const reader = createDecisionClient({ cacheDir, ttlSeconds: 3600 });

try {
  const probability = reader.lookup(request);
  // Interpret this probability in application code.
  console.log(probability);
} catch (error) {
  if (!(error instanceof DecisionError) || error.code !== 'cache-miss') throw error;
  // Treat absent evidence separately from a low probability.
}
```

`lookup` is synchronous and never uses the network, even on a client configured for remote resolution.
`resolve` is asynchronous and also defaults to cache-only.
To populate the cache from the Gateway, explicitly create a remote client outside the synchronous lint visitor:

```ts
const token = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
if (!token) throw new Error('Configure an AI Gateway token.');
const writer = createDecisionClient({ cacheDir, ttlSeconds: 3600, mode: 'remote', token });
const probability = await writer.resolve(request);
```

Remote clients use the same cache before making a request.
They send the configured request only on a miss, reject redirects, and do not change endpoints or models after a failure.
Use an explicit nonsecret `scope` that distinguishes tenants and authorization identities that must not share a decision.
Change the scope when the effective authorization changes, not just when an equivalent token rotates.
The scope and credentials do not belong in predicate input.
Remote requests send the input and question to the Gateway, subject to the Gateway's configured logging and retention.

`predicateKey(request)` returns the lowercase SHA-256 v1 digest shared with other Decision Kit clients.
`ttlSeconds` must be an integer from 60 through 2,592,000.
Use a directory controlled by the caller and inaccessible to other users.
The library creates private files and new directories on POSIX systems but does not change the permissions of existing directories.
Cache records contain only version, key, timestamps, and probability, not inputs, tokens, or errors.
A missing, expired, or future-dated decision throws `DecisionError` with `code: 'cache-miss'`.
Malformed records and I/O issues use separate codes and are not silently overwritten.

## Verify locally

Run these commands from `typescript/` after installing the build-time development dependencies:

```sh
npm test
npm run typecheck
npm run build
```

The tests use Node's built-in test runner and type stripping, a shared key vector, and local test transports.
They do not send live requests.

## Oxlint example

The repository example in `examples/oxlint/` shows how an opt-in rule can read a cached judgment from a synchronous visitor.
The rule warns separately about a suspected title mismatch and unavailable evidence.
Its fixtures use mock probabilities, not measurements of model accuracy.
Build the package before running the example test.
With a JS-plugin-capable Oxlint executable on `PATH`, run `npm run test:oxlint`.
Set `OXLINT_BIN` to use a particular executable instead.

To adopt the pattern, copy the example and configure `DECISION_KIT_CACHE_DIR` to point to a private cache directory.
Keep the predicate fields and the source extraction identical in the process that populates the cache and in the visitor that reads it.
Replace the placeholder endpoint and scope before populating it with real decisions.
