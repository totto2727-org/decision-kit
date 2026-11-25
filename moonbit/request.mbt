///|
#derive(Debug)
pub(all) suberror PredicateError {
  InvalidUnicode(String)
  EmptyScope
  InvalidEndpoint
  InvalidGatewayId
  InvalidModel
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
priv enum Protocol {
  OpenAI
  JevWorkers(String)
  JevSystemOne
}

///|
struct PredicateRequest {
  protocol : Protocol
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
  predicate_request(
    OpenAI,
    endpoint~,
    scope~,
    model~,
    name~,
    instructions~,
    input~,
  )
}

///|
pub fn PredicateRequest::jev(
  endpoint~ : String,
  scope~ : String,
  gateway_id? : String,
  model? : String,
  name~ : String,
  instructions~ : String,
  input~ : String,
) -> PredicateRequest raise PredicateError {
  let (protocol, model) = match gateway_id {
    Some(id) => {
      guard id =~ re"^[A-Za-z0-9_\-]+$" else { raise InvalidGatewayId }
      let selected = model.unwrap_or("typesafe/jev")
      guard selected == "typesafe/jev" else { raise InvalidModel }
      (JevWorkers(id), selected)
    }
    None => {
      let selected = model.unwrap_or("jev-latest")
      guard jev_alias(selected) || jev_release(selected) else {
        raise InvalidModel
      }
      (JevSystemOne, selected)
    }
  }
  predicate_request(
    protocol,
    endpoint~,
    scope~,
    model~,
    name~,
    instructions~,
    input~,
  )
}

///|
fn predicate_request(
  protocol : Protocol,
  endpoint~ : String,
  scope~ : String,
  model~ : String,
  name~ : String,
  instructions~ : String,
  input~ : String,
) -> PredicateRequest raise PredicateError {
  guard !scope.trim().is_empty() else { raise EmptyScope }
  let version = match protocol {
    OpenAI => "decision-kit/predicate/v1"
    JevWorkers(_) => "decision-kit/predicate/jev/v1"
    JevSystemOne => "decision-kit/predicate/jev-systemone/v1"
  }
  let identity = [
    ("version", version),
    ("scope", scope),
    ("endpoint", endpoint),
  ]
  if protocol is JevWorkers(gateway_id) {
    identity.push(("gatewayId", gateway_id))
  }
  identity.push(("model", model))
  identity.push(("name", name))
  identity.push(("instructions", instructions))
  identity.push(("input", input))
  let framed = @buffer.Buffer()
  for pair in identity {
    let (field, text) = pair
    let encoded = encode_scalar_string(field, text)
    framed.write_bytes(@utf8.encode("\{encoded.length()}:"))
    framed.write_bytes(encoded)
  }
  let cache_key = @crypto.bytes_to_hex_string(@crypto.sha256(framed.contents()))
  { protocol, endpoint, model, name, instructions, input, cache_key, }
}

///|
pub fn PredicateRequest::key(self : PredicateRequest) -> String {
  self.cache_key
}

///|
pub fn PredicateRequest::body(self : PredicateRequest) -> Json {
  match self.protocol {
    OpenAI => openai_body(self)
    JevWorkers(_) => jev_workers_body(self)
    JevSystemOne => jev_systemone_body(self)
  }
}

///|
fn openai_body(request : PredicateRequest) -> Json {
  {
    "model": Json::string(request.model),
    "input": Json::string(request.input),
    "questions": [
      {
        "type": "predicate",
        "name": Json::string(request.name),
        "instructions": Json::string(request.instructions),
      },
    ],
  }
}

///|
fn valid_probability(value : Double) -> Bool {
  value.is_finite() && value >= 0.0 && value <= 1.0
}
