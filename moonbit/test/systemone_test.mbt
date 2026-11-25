///|
let systemone_endpoint = "https://api.typesafe.ai/v1/systemone"

///|
let systemone_success = b"{\"model\":\"jev-1.14.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0.625}}}"

///|
let workers_success = b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.14.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0.625}}}}}"

///|
fn systemone_request(
  endpoint~ : String = systemone_endpoint,
  model? : String,
) -> @decision_kit.PredicateRequest raise {
  @decision_kit.PredicateRequest::jev(
    endpoint~,
    scope="local-demo",
    model?,
    name="accurate",
    instructions="Does the test title describe its assertion?",
    input="🌙\n東京:test",
  )
}

///|
async test "direct System One uses the independently calculated shared Unicode cache identity" {
  let file = @fs.read_file("../fixtures/jev-systemone-v1.json")
  guard @json.parse(file.text()) is Object(vector) else {
    fail("Invalid shared System One fixture")
  }
  let request = @decision_kit.PredicateRequest::jev(
    endpoint=field(vector, "endpoint"),
    scope=field(vector, "scope"),
    model=field(vector, "model"),
    name=field(vector, "name"),
    instructions=field(vector, "instructions"),
    input=field(vector, "input"),
  )
  @assertions.assert_eq(request.key(), field(vector, "key"))
  @assertions.assert_eq(request.key(), systemone_request().key())
}

///|
async test "System One sends a top-level state and Noul to both official and pinned endpoints" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  for url in [systemone_endpoint, pinned_proxy] {
    let pin = if url == systemone_endpoint { None } else { Some(url) }
    let remote = @decision_kit.Remote::new("typesafe-token", endpoint?=pin, transport=fn(
      actual,
      headers,
      body,
    ) raise {
      @assertions.assert_eq(actual, url)
      @assertions.assert_eq(headers, {
        "authorization": "Bearer typesafe-token",
        "content-type": "application/json",
      })
      let expected : Json = {
        "model": "jev-latest",
        "state": "🌙\n東京:test",
        "questions": {
          "accurate": {
            "type": "noul",
            "instructions": "Does the test title describe its assertion?",
          },
        },
      }
      assert_true(body == expected)
      (200, systemone_success)
    })
    let request = systemone_request(endpoint=url)
    inspect(
      @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~),
      content="0.625",
    )
  }
}

///|
async test "Workers AI keeps its envelope and Gateway header on a pinned proxy" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let request = jev_request(endpoint=pinned_proxy)
  let remote = @decision_kit.Remote::new(
    "workers-token",
    endpoint=pinned_proxy,
    transport=fn(url, headers, body) raise {
      @assertions.assert_eq(url, pinned_proxy)
      @assertions.assert_eq(headers, {
        "authorization": "Bearer workers-token",
        "cf-aig-gateway-id": "team",
        "content-type": "application/json",
      })
      let expected : Json = {
        "model": "typesafe/jev",
        "input": {
          "state": "🌙\n東京:test",
          "questions": {
            "accurate": {
              "type": "noul",
              "instructions": "Does the test title describe its assertion?",
            },
          },
        },
      }
      assert_true(body == expected)
      (200, workers_success)
    },
  )
  inspect(
    @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~),
    content="0.625",
  )
}

///|
async test "pinned provider-native Gateway uses one or two credentials independently of cache mode" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let url = "https://gateway.ai.cloudflare.com/v1/example/team/typesafe/systemone"
  let request = systemone_request(endpoint=url)
  let modes : Array[(String?, @decision_kit.RemoteCache?)] = [
    (None, None),
    (Some("gateway-token"), Some(@decision_kit.RemoteCache::None)),
    (Some("gateway-token"), Some(@decision_kit.RemoteCache::Cloudflare)),
  ]
  for i, mode in modes {
    let (gateway_token, remote_cache) = mode
    let remote = @decision_kit.Remote::new(
      "primary-token",
      endpoint=url,
      gateway_token?,
      remote_cache?,
      transport=fn(actual, headers, body) raise {
        @assertions.assert_eq(actual, url)
        assert_true(body == request.body())
        let expected = { "content-type": "application/json" }
        if gateway_token is Some(token) {
          expected["authorization"] = "Bearer primary-token"
          expected["cf-aig-authorization"] = "Bearer \{token}"
        } else {
          expected["cf-aig-authorization"] = "Bearer primary-token"
        }
        if remote_cache is Some(@decision_kit.RemoteCache::Cloudflare) {
          expected["cf-aig-cache-key"] = "decision-v1-\{request.key()}"
          expected["cf-aig-cache-ttl"] = "60"
          expected["cf-aig-skip-cache"] = "false"
        }
        @assertions.assert_eq(headers, expected)
        (200, systemone_success)
      },
    )
    let now = 1000L + 60L * i.to_int64()
    inspect(
      @decision_kit.resolve(request, cache_dir~, ttl=60, now~, remote~),
      content="0.625",
    )
  }
  @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [
    "\{request.key()}.json",
  ])
}

///|
async test "responses cannot cross wire protocols or replace an explicitly requested Jev release" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let invalid = [
    (systemone_request(), workers_success),
    (systemone_request(), success),
    (
      systemone_request(),
      b"{\"error\":\"failed\",\"model\":\"jev-latest\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0.625}}}",
    ),
    (systemone_request(model="jev-1.13.0"), systemone_success),
    (jev_request(), systemone_success),
    (request(), systemone_success),
  ]
  for pair in invalid {
    let (request, body) = pair
    let remote = @decision_kit.Remote::new("test-token", transport=fn(_, _, _) {
      (200, body)
    })
    guard capture(async fn() {
        @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~)
      })
      is Err(@decision_kit.InvalidResponse) else {
      fail("Expected the selected protocol and model to reject the response")
    }
  }
  @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [])
  for model in ["typesafe/jev", "other", "jev-1.14"] {
    let invalid_model = Ok(systemone_request(model~)) catch { err => Err(err) }
    guard invalid_model is Err(@decision_kit.InvalidModel) else {
      fail("Expected invalid System One model: \{model}")
    }
  }
}
