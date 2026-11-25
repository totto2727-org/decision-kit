///|
fn jev_body(request : PredicateRequest) -> Json {
  let questions : Map[String, Json] = Map([])
  questions[request.name] = {
    "type": "noul",
    "instructions": Json::string(request.instructions),
  }
  {
    "model": Json::string(request.model),
    "input": {
      "state": Json::string(request.input),
      "questions": Json::object(questions),
    },
  }
}

///|
fn jev_probability(
  request : PredicateRequest,
  json : Json,
) -> Double raise PredicateError {
  guard json is Object(envelope) &&
    envelope.get("success") is Some(True) &&
    envelope.get("result") is Some(Object(job)) &&
    job.get("state") is Some(String("Completed")) &&
    job.get("result") is Some(Object(result)) &&
    result.get("model") is Some(String(model)) &&
    model =~ re"^jev-[0-9]+[.][0-9]+[.][0-9]+$" &&
    result.get("answers") is Some(Object(answers)) &&
    answers.length() == 1 &&
    answers.get(request.name) is Some(Object(answer)) &&
    answer.get("type") is Some(String("noul")) &&
    answer.get("noul") is Some(Number(probability, ..)) &&
    valid_probability(probability) else {
    raise InvalidResponse
  }
  probability
}
