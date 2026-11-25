///|
fn jev_alias(model : String) -> Bool {
  model == "jev-latest" || model == "jev-preview"
}

///|
fn jev_release(model : String) -> Bool {
  model =~ re"^jev-[0-9]+[.][0-9]+[.][0-9]+$"
}

///|
fn jev_input(request : PredicateRequest) -> Map[String, Json] {
  let questions : Map[String, Json] = Map([])
  questions[request.name] = {
    "type": "noul",
    "instructions": Json::string(request.instructions),
  }
  { "state": Json::string(request.input), "questions": Json::object(questions) }
}

///|
fn jev_workers_body(request : PredicateRequest) -> Json {
  {
    "model": Json::string(request.model),
    "input": Json::object(jev_input(request)),
  }
}

///|
fn jev_systemone_body(request : PredicateRequest) -> Json {
  let fields = jev_input(request)
  fields["model"] = Json::string(request.model)
  Json::object(fields)
}

///|
fn jev_workers_probability(
  request : PredicateRequest,
  json : Json,
) -> Double raise PredicateError {
  guard json is Object(envelope) &&
    envelope.get("success") is Some(True) &&
    envelope.get("result") is Some(Object(job)) &&
    job.get("state") is Some(String("Completed")) &&
    job.get("result") is Some(Object(result)) &&
    result.get("model") is Some(String(model)) &&
    jev_release(model) else {
    raise InvalidResponse
  }
  jev_answer(request, result)
}

///|
fn jev_systemone_probability(
  request : PredicateRequest,
  json : Json,
) -> Double raise PredicateError {
  guard json is Object(result) &&
    (result.get("error") is None || result.get("error") is Some(Null)) &&
    result.get("model") is Some(String(model)) &&
    (model == request.model || (jev_alias(request.model) && jev_release(model))) else {
    raise InvalidResponse
  }
  jev_answer(request, result)
}

///|
fn jev_answer(
  request : PredicateRequest,
  result : Map[String, Json],
) -> Double raise PredicateError {
  guard result.get("answers") is Some(Object(answers)) &&
    answers.length() == 1 &&
    answers.get(request.name) is Some(Object(answer)) &&
    answer.get("type") is Some(String("noul")) &&
    answer.get("noul") is Some(Number(probability, ..)) &&
    valid_probability(probability) else {
    raise InvalidResponse
  }
  probability
}
