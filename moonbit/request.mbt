///|
#derive(Debug)
pub(all) suberror PredicateError {
  InvalidUnicode(String)
  EmptyScope
  InvalidEndpoint
  InvalidToken
  InvalidTtl
  InvalidTime
  CacheMiss
  InvalidCache
  CacheReadFailed
  CacheWriteFailed
  TransportFailed
  HttpStatus(Int32)
  InvalidResponse
}

///|
struct PredicateRequest {
  endpoint : String
  model : String
  name : String
  instructions : String
  input : String
  cache_key : String
}

///|
fn encode_scalar_string(
  field : String,
  value : String,
) -> Bytes raise PredicateError {
  let mut pending_high = false
  for i in 0..<value.length() {
    let unit = value.at(i).to_int()
    if pending_high {
      guard unit >= 0xDC00 && unit <= 0xDFFF else {
        raise InvalidUnicode(field)
      }
      pending_high = false
    } else if unit >= 0xD800 && unit <= 0xDBFF {
      pending_high = true
    } else if unit >= 0xDC00 && unit <= 0xDFFF {
      raise InvalidUnicode(field)
    }
  }
  guard !pending_high else { raise InvalidUnicode(field) }
  @utf8.encode(value)
}

///|
pub fn PredicateRequest::new(
  endpoint~ : String,
  scope~ : String,
  model~ : String,
  name~ : String,
  instructions~ : String,
  input~ : String,
) -> PredicateRequest raise PredicateError {
  guard !scope.trim().is_empty() else { raise EmptyScope }
  let framed = @buffer.Buffer()
  for
    pair in [
      ("version", "decision-kit/predicate/v1"),
      ("scope", scope),
      ("endpoint", endpoint),
      ("model", model),
      ("name", name),
      ("instructions", instructions),
      ("input", input),
    ] {
    let (field, text) = pair
    let encoded = encode_scalar_string(field, text)
    framed.write_bytes(@utf8.encode("\{encoded.length()}:"))
    framed.write_bytes(encoded)
  }
  let cache_key = @crypto.bytes_to_hex_string(@crypto.sha256(framed.contents()))
  { endpoint, model, name, instructions, input, cache_key, }
}

///|
pub fn PredicateRequest::key(self : PredicateRequest) -> String {
  self.cache_key
}

///|
pub fn PredicateRequest::body(self : PredicateRequest) -> Json {
  {
    "model": Json::string(self.model),
    "input": Json::string(self.input),
    "questions": [
      {
        "type": "predicate",
        "name": Json::string(self.name),
        "instructions": Json::string(self.instructions),
      },
    ],
  }
}

///|
fn valid_probability(value : Double) -> Bool {
  value.is_finite() && value >= 0.0 && value <= 1.0
}
