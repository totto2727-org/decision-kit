///|
let jev_endpoint = "https://api.cloudflare.com/client/v4/accounts/example/ai/run"

///|
fn jev_request(
  endpoint~ : String = jev_endpoint,
  gateway_id~ : String = "team",
) -> @decision_kit.PredicateRequest raise {
  @decision_kit.PredicateRequest::jev(
    endpoint~,
    scope="local-demo",
    name="accurate",
    instructions="Does the test title describe its assertion?",
    input="🌙\n東京:test",
    gateway_id~,
  )
}

///|
async test "Jev sends one authenticated Noul question and reuses only the matching Gateway cache entry" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let request = jev_request()
  let mut calls = 0
  let remote = @decision_kit.Remote::new("test-token", transport=fn(
    url,
    headers,
    body,
  ) raise {
    calls += 1
    @assertions.assert_eq(url, jev_endpoint)
    @assertions.assert_eq(headers, {
      "authorization": "Bearer test-token",
      "cf-aig-gateway-id": "team",
      "cf-aig-cache-key": "decision-v1-\{request.key()}",
      "cf-aig-cache-ttl": "60",
      "cf-aig-skip-cache": "false",
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
    (
      200, b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0}},\"usage\":{\"input_tokens\":42,\"output_tokens\":1}}}}",
    )
  })
  guard capture(async fn() {
      @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000)
    })
    is Err(@decision_kit.CacheMiss) else {
    fail("Expected an offline miss before explicitly opting in")
  }
  inspect(
    @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~),
    content="0",
  )
  inspect(
    @decision_kit.resolve(request, cache_dir~, ttl=60, now=1059, remote~),
    content="0",
  )
  @assertions.assert_eq(calls, 1)
  let other_gateway = jev_request(gateway_id="other")
  guard capture(async fn() {
      @decision_kit.read_cached(other_gateway, cache_dir~, ttl=60, now=1059)
    })
    is Err(@decision_kit.CacheMiss) else {
    fail("A different Gateway cannot read the cached judgment")
  }
}

///|
test "Jev rejects invalid Gateway IDs" {
  for gateway_id in ["", "team\n", "team\r\nInjected", "team/other"] {
    let result = Ok(jev_request(gateway_id~)) catch { err => Err(err) }
    guard result is Err(@decision_kit.InvalidGatewayId) else {
      fail("Expected an invalid Gateway ID to be rejected")
    }
  }
}

///|
async test "Jev rejects credential destinations, incomplete jobs and invalid answer coverage without caching" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let unexpected = @decision_kit.Remote::new("test-token", transport=fn(
    _,
    _,
    _,
  ) raise {
    fail("Never send Jev credentials to another destination")
  })
  for
    url in [
      "https://api.typesafe.ai/v1/systemone",
      "https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions",
      "https://api.cloudflare.com@other.test/client/v4/accounts/example/ai/run",
      "\{jev_endpoint}?extra=true",
      "\{jev_endpoint}\n",
    ] {
    guard capture(async fn() {
        @decision_kit.resolve(
          jev_request(endpoint=url),
          cache_dir~,
          ttl=60,
          now=1000,
          remote=unexpected,
        )
      })
      is Err(@decision_kit.InvalidEndpoint) else {
      fail("Expected a fixed Jev credential destination")
    }
  }
  let request = jev_request()
  for
    body in [
      b"{\"success\":false,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Running\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"wrong\":{\"type\":\"noul\",\"noul\":0}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0},\"extra\":{}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":1.01}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"jev-1.13.0\",\"answers\":{\"accurate\":{\"type\":\"score\",\"noul\":0}}}}}",
      b"{\"success\":true,\"result\":{\"state\":\"Completed\",\"result\":{\"model\":\"typesafe/jev\",\"answers\":{\"accurate\":{\"type\":\"noul\",\"noul\":0}}}}}",
    ] {
    let remote = @decision_kit.Remote::new("test-token", transport=fn(_, _, _) {
      (200, body)
    })
    guard capture(async fn() {
        @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~)
      })
      is Err(@decision_kit.InvalidResponse) else {
      fail("Expected malformed Jev response rejection")
    }
  }
  @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [])
}
