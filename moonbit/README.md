# Decision Kit for MoonBit

Import `totto2727/decision-kit` as `@decision_kit` in a native MoonBit package.
Decision Kit uses the official MoonBit async filesystem and HTTP libraries and does not require a subprocess.
See the [shared predicate v1 contract](../README.md#predicate-v1) for cache interoperability with TypeScript.

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

`request.key()` is the lowercase SHA-256 cache key, and `request.body()` is the one-question Decisions JSON.
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
The built-in transport performs a single HTTPS POST with system trust roots and a 90-second timeout.
It does not follow redirects or change the route, and it accepts only the Cloudflare Gateway OpenAI Decisions URL shown above with the account and Gateway IDs replaced.
Supply the bearer token through your application's secret storage and never include it in `scope`.
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
