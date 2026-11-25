# Decision Kit for MoonBit

Import `totto2727/decision-kit` as `@decision_kit` in a native MoonBit package.
Decision Kit uses the official MoonBit async filesystem and HTTP libraries and does not require a subprocess.
Choose OpenAI Decisions or Jev when you construct a request.
See the [shared cache contract](../README.md#interoperable-cache) for cache interoperability with TypeScript.

## Read a predicate from the cache

Call this code in a MoonBit async context.
Choose a nonsecret `scope` that identifies the tenant and the credential's permissions.
The cache directory must be controlled by the calling application and not writable by other users.

```moonbit
let request = @decision_kit.PredicateRequest::new(
  endpoint="https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions",
  scope="local-team",
  model="gpt-6-luna",
  name="accurate",
  instructions="Does the test title describe its assertion?",
  input="Test title: returns zero. Assertion: result == 0.",
)
let probability = @decision_kit.read_cached(request, cache_dir~, ttl=3600)
```

To select Jev instead of OpenAI Decisions, use `PredicateRequest::jev`.
Set `gateway_id` to the ID of the AI Gateway that must handle the Workers AI request.
The constructor sets the model ID to `typesafe/jev`.

```moonbit
let request = @decision_kit.PredicateRequest::jev(
  endpoint="https://api.cloudflare.com/client/v4/accounts/example/ai/run",
  gateway_id="team",
  scope="local-team",
  name="accurate",
  instructions="Does the test title describe its assertion?",
  input="Test title: returns zero. Assertion: result == 0.",
)
let probability = @decision_kit.read_cached(request, cache_dir~, ttl=3600)
```

`request.key()` returns the lowercase SHA-256 cache key.
OpenAI Decisions and Jev use separate cache keys.
For Jev, the Gateway ID is part of the key.
`request.body()` returns one question in the selected provider's format.
`read_cached` and `resolve` without `remote` never make network requests.
Missing, future-dated, and expired records raise `CacheMiss`.
Malformed records raise `InvalidCache`, and other filesystem read failures raise `CacheReadFailed`.
Use `now=` with integer Unix seconds to supply a fixed clock for testing.
Cache timestamps must be within the JavaScript safe integer range for interoperability.

## Opt in to the Gateway

```moonbit
let remote = @decision_kit.Remote::new(gateway_token)
let probability = @decision_kit.resolve(request, cache_dir~, ttl=3600, remote~)
```

`resolve` calls the Gateway only on `CacheMiss`, and it sends the full input to the configured Gateway on that call.
The built-in transport sends one HTTPS POST with system trust roots and a 90-second timeout.
The transport does not follow redirects or switch routes after a failure.

- For [OpenAI Decisions](https://developers.openai.com/api/reference/resources/decisions/methods/create), use the `gateway.ai.cloudflare.com` URL shown above.
  Replace the account and Gateway IDs.
  Supply a token for the `cf-aig-authorization` header.
- For [Jev through Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/rest-api/), use the `api.cloudflare.com` Workers AI URL shown above.
  Replace the account ID.
  Supply a Workers AI token for the `Authorization` header.
  The client sends `gateway_id` in the `cf-aig-gateway-id` header.
  The client does not contact the direct TypeSafe API.

Both routes send the Gateway cache key and TTL headers by default.
The Gateway cache key is `decision-v1-` followed by `request.key()`.
Keep the token in your application's secret storage.
Do not include it in `scope`.
Do not log transport headers or request bodies.

If missing, the cache directory is created with owner-only permissions on POSIX systems.
The client does not change existing directory permissions.
Only a validated probability and its v1 cache metadata are written, using a private temporary file and same-directory rename.
Read and write failures remain errors rather than being converted to a probability.

## Test locally

From the repository root, run `cd moonbit && moon test --target native --deny-warn`.
The tests read the shared fixture and inject a fake transport through `Remote::new(token, transport=...)`.
The transport receives the endpoint, headers, and `Json` body and returns an HTTP status and response bytes.
Use only trusted callbacks, since they receive the same credentials and input as the built-in transport and are responsible for not forwarding them.
The tests do not contact the live provider or require credentials.

Decision Kit uses the [MIT license](../LICENSE).
