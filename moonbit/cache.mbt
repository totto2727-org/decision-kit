///|
let max_epoch : Int64 = 9007199254740991L

///|
fn epoch_seconds() -> Int64 {
  (@env.now() / 1000UL).reinterpret_as_int64()
}

///|
fn validate_ttl(ttl : Int32) -> Unit raise PredicateError {
  guard ttl >= 60 && ttl <= 2592000 else { raise InvalidTtl }
}

///|
fn validate_time(now : Int64) -> Unit raise PredicateError {
  guard now >= -max_epoch && now <= max_epoch else { raise InvalidTime }
}

///|
fn decode_epoch(value : Double) -> Int64 raise PredicateError {
  guard value.is_finite() &&
    value >= -max_epoch.to_double() &&
    value <= max_epoch.to_double() else {
    raise InvalidCache
  }
  let integer = value.to_int64()
  guard integer.to_double() == value else { raise InvalidCache }
  integer
}

///|
fn cache_path(request : PredicateRequest, cache_dir : String) -> String {
  "\{cache_dir}/\{request.key()}.json"
}

///|
fn cached_probability(
  record : Json,
  request : PredicateRequest,
  ttl : Int32,
  now : Int64,
) -> Double raise PredicateError {
  guard record is Object(fields) &&
    fields.get("version") is Some(Number(1.0, ..)) &&
    fields.get("key") is Some(String(key)) &&
    key == request.key() &&
    fields.get("createdAt") is Some(Number(created, ..)) &&
    fields.get("expiresAt") is Some(Number(expires, ..)) &&
    fields.get("probability") is Some(Number(probability, ..)) &&
    valid_probability(probability) else {
    raise InvalidCache
  }
  let created = decode_epoch(created)
  let expires = decode_epoch(expires)
  guard now >= created && now < expires && now - created < ttl.to_int64() else {
    raise CacheMiss
  }
  probability
}

///|
fn parse_json(bytes : Bytes) -> Json raise {
  @json.parse(@utf8.decode(bytes, ignore_bom=true), reject_duplicate_keys=true)
}

///|
pub async fn read_cached(
  request : PredicateRequest,
  cache_dir~ : String,
  ttl~ : Int32,
  now~ : Int64 = epoch_seconds(),
) -> Double {
  validate_ttl(ttl)
  validate_time(now)
  guard cache_dir != "" && !cache_dir.contains_code_unit(0) else {
    raise PredicateError::CacheReadFailed
  }
  let path = cache_path(request, cache_dir)
  let bytes = try {
    guard @fs.kind(path, follow_symlink=false) is Regular else {
      raise PredicateError::InvalidCache
    }
    let body = @fs.read_file(path)
    body.binary()
  } catch {
    @os_error.OSError(_) as err if err.is_ENOENT() =>
      raise PredicateError::CacheMiss
    PredicateError::InvalidCache => raise PredicateError::InvalidCache
    _ => raise PredicateError::CacheReadFailed
  }
  let record = parse_json(bytes) catch {
    _ => raise PredicateError::InvalidCache
  }
  cached_probability(record, request, ttl, now)
}

///|
async fn write_cache(
  request : PredicateRequest,
  cache_dir : String,
  ttl : Int32,
  now : Int64,
  probability : Double,
) -> Unit {
  let expires = now + ttl.to_int64()
  validate_time(expires)
  let key = request.key()
  let record : Json = {
    "version": 1,
    "key": Json::string(key),
    "createdAt": Json::number(now.to_double()),
    "expiresAt": Json::number(expires.to_double()),
    "probability": Json::number(probability),
  }
  guard @env.rand(16) is Some(entropy) else {
    raise PredicateError::CacheWriteFailed
  }
  let nonce = @crypto.bytes_to_hex_string(entropy)
  let temporary = "\{cache_dir}/.\{key}.\{nonce}.tmp"
  try {
    @fs.mkdir(cache_dir, permission=0o700, recursive=true, allow_exist=true)
    @async.protect_from_cancel(async fn() {
      let file = @fs.create(temporary, allow_existing=false, permission=0o600)
      errdefer (@fs.remove(temporary, allow_missing=true) catch { _ => () })
      {
        defer file.close()
        file.write(record.stringify())
        file.sync()
      }
      @fs.rename(temporary, cache_path(request, cache_dir), replace=true)
    })
  } catch {
    _ => raise PredicateError::CacheWriteFailed
  }
}
