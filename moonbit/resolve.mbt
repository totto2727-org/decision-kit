///|
pub type Transport = async (String, Map[String, String], Json) -> (Int32, Bytes)

///|
struct Remote {
  token : String
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
  transport~ : Transport = gateway_post,
) -> Remote raise PredicateError {
  guard token =~ re"^[A-Za-z0-9._~+/\-]+=*$" else { raise InvalidToken }
  { token, transport, }
}

///|
fn validate_endpoint(request : PredicateRequest) -> Unit raise PredicateError {
  let endpoint = request.endpoint
  let valid = match request.protocol {
    OpenAI =>
      endpoint =~ re"^https://gateway[.]ai[.]cloudflare[.]com/v1/[A-Za-z0-9_\-]+/[A-Za-z0-9_\-]+/openai/decisions$"
    Jev(_) =>
      endpoint =~ re"^https://api[.]cloudflare[.]com/client/v4/accounts/[A-Za-z0-9_\-]+/ai/run$"
  }
  guard valid else { raise InvalidEndpoint }
}

///|
fn openai_probability(
  request : PredicateRequest,
  json : Json,
) -> Double raise PredicateError {
  guard json is Object(fields) &&
    (fields.get("error") is None || fields.get("error") is Some(Null)) &&
    fields.get("model") is Some(String(model)) &&
    model == request.model &&
    fields.get("answers") is Some(Array([Object(answer)])) &&
    answer.get("type") is Some(String("predicate")) &&
    answer.get("name") is Some(String(name)) &&
    name == request.name &&
    answer.get("probability") is Some(Number(probability, ..)) &&
    valid_probability(probability) else {
    raise InvalidResponse
  }
  probability
}

///|
pub async fn resolve(
  request : PredicateRequest,
  cache_dir~ : String,
  ttl~ : Int32,
  now? : Int64,
  remote? : Remote,
) -> Double {
  let lookup_time = now.unwrap_or_else(epoch_seconds)
  try read_cached(request, cache_dir~, ttl~, now=lookup_time) catch {
    PredicateError::CacheMiss => ()
    err => raise err
  } noraise {
    probability => return probability
  }
  guard remote is Some(remote) else { raise PredicateError::CacheMiss }
  validate_endpoint(request)
  validate_time(lookup_time + ttl.to_int64())
  let headers = {
    "cf-aig-cache-key": "decision-v1-\{request.key()}",
    "cf-aig-cache-ttl": ttl.to_string(),
    "cf-aig-skip-cache": "false",
    "content-type": "application/json",
  }
  match request.protocol {
    OpenAI => headers["cf-aig-authorization"] = "Bearer \{remote.token}"
    Jev(gateway_id) => {
      headers["authorization"] = "Bearer \{remote.token}"
      headers["cf-aig-gateway-id"] = gateway_id
    }
  }
  let (status, bytes) = (remote.transport)(
    request.endpoint,
    headers,
    request.body(),
  ) catch {
    _ => raise PredicateError::TransportFailed
  }
  guard status >= 200 && status < 300 else {
    raise PredicateError::HttpStatus(status)
  }
  let json = parse_json(bytes) catch {
    _ => raise PredicateError::InvalidResponse
  }
  let probability = match request.protocol {
    OpenAI => openai_probability(request, json)
    Jev(_) => jev_probability(request, json)
  }
  let written_at = now.unwrap_or_else(epoch_seconds)
  write_cache(request, cache_dir, ttl, written_at, probability)
  probability
}
