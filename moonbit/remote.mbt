///|
pub type Transport = async (String, Map[String, String], Json) -> (Int32, Bytes)

///|
pub(all) enum RemoteCache {
  None
  Cloudflare
}

///|
struct Remote {
  token : String
  gateway_token : String?
  endpoint : String?
  remote_cache : RemoteCache?
  transport : Transport
}

///|
async fn gateway_post(
  endpoint : String,
  headers : Map[String, String],
  body : Json,
) -> (Int32, Bytes) {
  let wire_headers : @http.Headers = Map([])
  for name, value in headers {
    wire_headers[@http.CaseInsensitiveString(name)] = value
  }
  @async.with_timeout(90000, async fn() {
    let (response, data) = @http.post(endpoint, body, headers=wire_headers)
    (response.code, data.binary())
  })
}

///|
pub fn Remote::new(
  token : String,
  endpoint? : String,
  gateway_token? : String,
  remote_cache? : RemoteCache,
  transport~ : Transport = gateway_post,
) -> Remote raise PredicateError {
  guard valid_bearer(token) else { raise InvalidToken }
  if gateway_token is Some(token) {
    guard valid_bearer(token) else { raise InvalidToken }
  }
  if endpoint is Some(url) {
    validate_pinned_endpoint(url)
    if gateway_token is Some(_) {
      guard gateway_authority(url) else { raise InvalidEndpoint }
    }
  }
  { token, gateway_token, endpoint, remote_cache, transport, }
}

///|
fn valid_bearer(token : String) -> Bool {
  token =~ re"^[A-Za-z0-9._~+/\-]+=*$"
}

///|
fn validate_pinned_endpoint(endpoint : String) -> Unit raise PredicateError {
  guard endpoint =~ (
    re"^https://" +
    (re"[a-z0-9.:\-]+" as authority) +
    (re"/[A-Za-z0-9._~/\-]*" as path) +
    re"$"
  ) else {
    raise InvalidEndpoint
  }
  let host = if authority.find(":") is Some(index) {
    let port = authority[index + 1:]
    guard port =~ re"^[1-9][0-9]{0,4}$" else { raise InvalidEndpoint }
    let port = @string.parse_int(port) catch { _ => raise InvalidEndpoint }
    guard port <= 65535 else { raise InvalidEndpoint }
    authority[:index]
  } else {
    authority
  }
  guard host.length() <= 253 else { raise InvalidEndpoint }
  let mut last_label : StringView = ""
  for label in host.split(".") {
    guard label =~ re"^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?$" else {
      raise InvalidEndpoint
    }
    last_label = label
  }
  guard last_label =~ re"^[a-z][a-z0-9\-]*$" && !path.contains("//") else {
    raise InvalidEndpoint
  }
  for segment in path.split("/") {
    guard segment != "." && segment != ".." else { raise InvalidEndpoint }
  }
}

///|
fn gateway_authority(endpoint : String) -> Bool {
  endpoint.has_prefix("https://gateway.ai.cloudflare.com/")
}

///|
fn canonical_cloudflare_endpoint(request : PredicateRequest) -> Bool {
  match request.protocol {
    OpenAI =>
      request.endpoint =~ re"^https://gateway[.]ai[.]cloudflare[.]com/v1/[A-Za-z0-9_\-]+/[A-Za-z0-9_\-]+/openai/decisions$"
    JevWorkers(_) =>
      request.endpoint =~ re"^https://api[.]cloudflare[.]com/client/v4/accounts/[A-Za-z0-9_\-]+/ai/run$"
    JevSystemOne => false
  }
}

///|
fn official_direct_endpoint(request : PredicateRequest) -> Bool {
  match request.protocol {
    OpenAI => request.endpoint == "https://api.openai.com/v1/decisions"
    JevSystemOne => request.endpoint == "https://api.typesafe.ai/v1/systemone"
    JevWorkers(_) => false
  }
}

///|
fn remote_headers(
  request : PredicateRequest,
  remote : Remote,
  ttl : Int32,
) -> Map[String, String] raise PredicateError {
  let canonical = canonical_cloudflare_endpoint(request)
  let trusted = match remote.endpoint {
    Some(endpoint) => endpoint == request.endpoint
    None => canonical || official_direct_endpoint(request)
  }
  guard trusted else { raise InvalidEndpoint }
  let gateway = gateway_authority(request.endpoint)
  guard remote.gateway_token is None || gateway else { raise InvalidEndpoint }
  let bearer = "Bearer \{remote.token}"
  let headers = { "content-type": "application/json" }
  match request.protocol {
    JevWorkers(gateway_id) => {
      headers["authorization"] = bearer
      headers["cf-aig-gateway-id"] = gateway_id
    }
    OpenAI | JevSystemOne if gateway && remote.gateway_token is None =>
      headers["cf-aig-authorization"] = bearer
    OpenAI | JevSystemOne => headers["authorization"] = bearer
  }
  if remote.gateway_token is Some(token) {
    headers["cf-aig-authorization"] = "Bearer \{token}"
  }
  let send_cache = match remote.remote_cache {
    Some(RemoteCache::Cloudflare) => true
    Some(RemoteCache::None) => false
    None => canonical
  }
  if send_cache {
    headers["cf-aig-cache-key"] = "decision-v1-\{request.key()}"
    headers["cf-aig-cache-ttl"] = ttl.to_string()
    headers["cf-aig-skip-cache"] = "false"
  }
  headers
}
