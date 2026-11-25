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
  let headers = remote_headers(request, remote, ttl)
  validate_time(lookup_time + ttl.to_int64())
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
    JevWorkers(_) => jev_workers_probability(request, json)
    JevSystemOne => jev_systemone_probability(request, json)
  }
  let written_at = now.unwrap_or_else(epoch_seconds)
  write_cache(request, cache_dir, ttl, written_at, probability)
  probability
}
