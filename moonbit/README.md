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

To select [TypeSafe System One](https://docs.typesafe.ai/go/api.md), use `PredicateRequest::jev` without `gateway_id`.
The model defaults to `jev-latest`.
Set `model` to `jev-preview` or a release such as `jev-1.14.0` to select a different model.

```moonbit
let request = @decision_kit.PredicateRequest::jev(
  endpoint="https://api.typesafe.ai/v1/systemone",
  scope="local-team",
  name="accurate",
  instructions="Does the test title describe its assertion?",
  input="Test title: returns zero. Assertion: result == 0.",
)
let probability = @decision_kit.read_cached(request, cache_dir~, ttl=3600)
```

To use the Cloudflare Workers AI form of Jev, set `endpoint` to `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run` and supply `gateway_id`.
The model for this form is `typesafe/jev`.

`request.key()` returns the lowercase SHA-256 cache key.
OpenAI Decisions, Jev through Workers AI, and Jev System One have separate cache keys.
The Workers AI key includes the Gateway ID.
`request.body()` returns one question in the selected provider's format.
`read_cached` and `resolve` without `remote` never make network requests.
Missing, future-dated, and expired records raise `CacheMiss`.
Malformed records raise `InvalidCache`, and other filesystem read failures raise `CacheReadFailed`.
Use `now=` with integer Unix seconds to supply a fixed clock for testing.
Cache timestamps must be within the JavaScript safe integer range for interoperability.

## Opt in to a remote request

```moonbit
let remote = @decision_kit.Remote::new(token)
let probability = @decision_kit.resolve(request, cache_dir~, ttl=3600, remote~)
```

`resolve` makes a remote request only on `CacheMiss` and sends the full input on that call.
The built-in transport sends one HTTPS POST with system trust roots and a 90-second timeout.
The transport does not follow redirects or switch routes after a failure.

The request endpoint is the full URL, including its path.
The transport does not append a path.
You can omit `endpoint` on `Remote::new` for these standard URLs when they match the request format:

| Request format                                                                                     | Standard endpoint                                                           | Authentication                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| [OpenAI Decisions](https://developers.openai.com/api/reference/resources/decisions/methods/create) | `https://api.openai.com/v1/decisions`                                       | `Authorization`                         |
| OpenAI Decisions through AI Gateway                                                                | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/decisions` | `cf-aig-authorization`                  |
| Jev System One                                                                                     | `https://api.typesafe.ai/v1/systemone`                                      | `Authorization`                         |
| Jev through Workers AI                                                                             | `https://api.cloudflare.com/client/v4/accounts/<account>/ai/run`            | `Authorization` and `cf-aig-gateway-id` |

For any other URL, set `endpoint` on `Remote::new` from trusted application configuration.
The request endpoint must match it exactly, even if the request names a standard URL.

```moonbit
let remote = @decision_kit.Remote::new(token, endpoint=trusted_endpoint)
let probability = @decision_kit.resolve(request, cache_dir~, ttl=3600, remote~)
```

Use `https://`, a lowercase ASCII DNS host, an optional decimal port, and an absolute path.
The path can contain ASCII letters, digits, `-`, `.`, `_`, `~`, and `/`.
Do not use credentials in the URL, a query, a fragment, percent encoding, doubled slashes in the path, or `.` and `..` path components.
The remote sends no credentials when the pin does not match.

### Authenticate to a pinned Cloudflare proxy

For OpenAI Decisions or Jev System One at the exact `https://gateway.ai.cloudflare.com/` authority, the client sends `token` in `cf-aig-authorization` for a stored provider key.
If the proxy requires both a provider token and a separate Cloudflare token, pass the Cloudflare token as `gateway_token`.
The client then sends `token` in `Authorization` and `gateway_token` in `cf-aig-authorization`.
The client rejects `gateway_token` for every other authority, including `api.cloudflare.com`.
See [Cloudflare AI Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/index.md).

### Select the remote cache policy

The two standard Cloudflare routes send the Gateway cache headers by default.
Direct endpoints and pinned nonstandard routes omit them by default.
Set `remote_cache=@decision_kit.RemoteCache::Cloudflare` to send the cache headers, or set `remote_cache=@decision_kit.RemoteCache::None` to omit them.
This option does not change credentials, the request URL, or the local cache key.
Omitting the headers leaves the remote cache policy to the service.
The Gateway cache key is `decision-v1-` followed by `request.key()`.
Keep all tokens in your application's secret storage.
Do not include a token in `scope`.
Do not log transport headers or request bodies.

If missing, the cache directory is created with owner-only permissions on POSIX systems.
The client does not change existing directory permissions.
Only a validated probability and its v1 cache metadata are written, using a private temporary file and same-directory rename.
Read and write failures remain errors rather than being converted to a probability.

## Test locally

From the repository root, run `cd moonbit && moon test --target native --deny-warn`.
The tests read the shared fixtures and inject a fake transport through `Remote::new(token, transport=...)`.
The transport receives the endpoint, headers, and `Json` body and returns an HTTP status and response bytes.
Use only trusted callbacks, since they receive the same credentials and input as the built-in transport and are responsible for not forwarding them.
The tests do not contact the live provider or require credentials.

Decision Kit uses the [MIT license](../LICENSE).
