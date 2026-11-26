///|
let endpoint = "https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions"

///|
let success = b"{\"error\":null,\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":0.75}]}"

///|
fn request(
  endpoint~ : String = endpoint,
  scope~ : String = "local-demo",
  input~ : String = "🌙\n東京:test",
) -> @decision_kit.PredicateRequest raise {
  @decision_kit.PredicateRequest::new(
    endpoint~,
    scope~,
    model="gpt-6-luna",
    name="accurate",
    instructions="Does the test title describe its assertion?",
    input~,
  )
}

///|
fn field(fields : Map[String, Json], name : String) -> String raise {
  guard fields.get(name) is Some(String(value)) else {
    fail("Missing string: \{name}")
  }
  value
}

///|
async test "shared predicate v1 fixture encodes supplementary characters, CJK, newline and colon" {
  let file = @fs.read_file("fixtures/predicate-v1.json")
  guard @json.parse(file.text()) is Object(vector) else {
    fail("Invalid shared fixture")
  }
  let request = @decision_kit.PredicateRequest::new(
    endpoint=field(vector, "endpoint"),
    scope=field(vector, "scope"),
    model=field(vector, "model"),
    name=field(vector, "name"),
    instructions=field(vector, "instructions"),
    input=field(vector, "input"),
  )
  @assertions.assert_eq(request.key(), field(vector, "key"))
}

///|
test "missing authorization scope cannot select a shared cache entry" {
  for scope in ["", " \t\n"] {
    let result = Ok(request(scope~)) catch { err => Err(err) }
    guard result is Err(@decision_kit.EmptyScope) else {
      fail("Expected EmptyScope")
    }
  }
}

///|
test "predicate input rejects isolated high and low UTF-16 surrogates" {
  for
    input in [
      "🌙".unsafe_substring(start=0, end=1),
      "🌙".unsafe_substring(start=1, end=2),
    ] {
    let result = Ok(request(input~)) catch { err => Err(err) }
    guard result is Err(@decision_kit.InvalidUnicode("input")) else {
      fail("Expected InvalidUnicode for input")
    }
  }
}

///|
#warnings("-result_error_return")
async fn[T] capture(call : async () -> T) -> Result[T, Error] {
  Ok(call()) catch {
    err => Err(err)
  }
}

///|
async test "resolve posts the exact request on opt-in, persists just the cache record, and can read it offline" {
  let root = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(root, recursive=true)
  let cache_dir = "\{root}/cache"
  let request = request()
  let remote = @decision_kit.Remote::new("test.token_123", transport=fn(
    url,
    headers,
    body,
  ) raise {
    @assertions.assert_eq(url, endpoint)
    @assertions.assert_eq(headers, {
      "cf-aig-authorization": "Bearer test.token_123",
      "cf-aig-cache-key": "decision-v1-\{request.key()}",
      "cf-aig-cache-ttl": "60",
      "cf-aig-skip-cache": "false",
      "content-type": "application/json",
    })
    let expected : Json = {
      "model": "gpt-6-luna",
      "input": "🌙\n東京:test",
      "questions": [
        {
          "type": "predicate",
          "name": "accurate",
          "instructions": "Does the test title describe its assertion?",
        },
      ],
    }
    assert_true(body == expected)
    (200, success)
  })
  guard capture(async fn() {
      @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000)
    })
    is Err(@decision_kit.CacheMiss) else {
    fail("Expected explicit offline cache miss")
  }
  inspect(
    @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~),
    content="0.75",
  )
  inspect(
    @decision_kit.resolve(request, cache_dir~, ttl=120, now=1059),
    content="0.75",
  )
  let unexpected = @decision_kit.Remote::new("test-token", transport=fn(
    _,
    _,
    _,
  ) raise {
    fail("A valid local hit must not call the transport")
  })
  inspect(
    @decision_kit.resolve(
      request,
      cache_dir~,
      ttl=120,
      now=1059,
      remote=unexpected,
    ),
    content="0.75",
  )
  let slot = "\{request.key()}.json"
  @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [slot])
  let entry = @fs.read_file("\{cache_dir}/\{slot}")
  let expected : Json = {
    "version": 1,
    "key": Json::string(request.key()),
    "createdAt": 1000,
    "expiresAt": 1060,
    "probability": 0.75,
  }
  assert_true(entry.json() == expected)
  guard capture(async fn() {
      @decision_kit.read_cached(request, cache_dir~, ttl=120, now=1060)
    })
    is Err(@decision_kit.CacheMiss) else {
    fail("The stored expiry is exclusive")
  }
}

///|
async test "cache-only validates timestamps, probability, key and the caller TTL" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let request = request()
  let key = request.key()
  let path = "\{cache_dir}/\{key}.json"
  let record = "{\"version\":1,\"key\":\"\{key}\",\"createdAt\":1000,\"expiresAt\":2000,\"probability\":0}"
  @fs.write_file(path, record)
  inspect(
    @decision_kit.read_cached(request, cache_dir~, ttl=60, now=1000),
    content="0",
  )
  for now in [999L, 1060L] {
    guard capture(async fn() {
        @decision_kit.read_cached(request, cache_dir~, ttl=60, now~)
      })
      is Err(@decision_kit.CacheMiss) else {
      fail("Future and caller-expired entries must miss")
    }
  }
  for ttl in [59, 2592001] {
    guard capture(async fn() {
        @decision_kit.read_cached(request, cache_dir~, ttl~, now=1000)
      })
      is Err(@decision_kit.InvalidTtl) else {
      fail("TTL outside v1 range")
    }
  }
  for
    invalid in [
      "not JSON",
      "{\"version\":2,\"key\":\"\{key}\",\"createdAt\":1000,\"expiresAt\":2000,\"probability\":0}",
      "{\"version\":1,\"key\":\"different\",\"createdAt\":1000,\"expiresAt\":2000,\"probability\":0}",
      "{\"version\":1,\"key\":\"\{key}\",\"createdAt\":999.5,\"expiresAt\":2000,\"probability\":0}",
      "{\"version\":1,\"key\":\"\{key}\",\"createdAt\":1000,\"expiresAt\":2000,\"probability\":1.01}",
      "{\"version\":1,\"key\":\"\{key}\",\"createdAt\":1000,\"expiresAt\":2000,\"probability\":1e999}",
    ] {
    @fs.write_file(path, invalid)
    guard capture(async fn() {
        @decision_kit.read_cached(request, cache_dir~, ttl=60, now=1000)
      })
      is Err(@decision_kit.InvalidCache) else {
      fail("Expected invalid cache record")
    }
  }
}

///|
async test "resolve rejects fallback routes, redirects, bad credentials, and invalid Decisions responses" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let redirect = @decision_kit.Remote::new("test-token", transport=fn(_, _, _) {
    (302, b"")
  })
  for
    url in [
      "https://api.openai.com/v1/decisions/other",
      "https://gateway.ai.cloudflare.com@invalid.test/v1/example/team/openai/decisions",
      "\{endpoint}?next=invalid",
      "\{endpoint}\n",
    ] {
    guard capture(async fn() {
        @decision_kit.resolve(
          request(endpoint=url),
          cache_dir~,
          ttl=60,
          now=1000,
          remote=redirect,
        )
      })
      is Err(@decision_kit.InvalidEndpoint) else {
      fail("Expected credential destination rejection")
    }
  }
  let result = Ok(@decision_kit.Remote::new("token\r\nInjected: header")) catch {
    err => Err(err)
  }
  guard result is Err(@decision_kit.InvalidToken) else {
    fail("Expected invalid token rejection")
  }
  let request = request()
  guard capture(async fn() {
      @decision_kit.resolve(
        request,
        cache_dir~,
        ttl=60,
        now=1000,
        remote=redirect,
      )
    })
    is Err(@decision_kit.HttpStatus(302)) else {
    fail("Expected redirects to be non-success")
  }
  let failed = @decision_kit.Remote::new("test-token", transport=fn(
    _,
    _,
    _,
  ) raise {
    fail("simulated network failure")
  })
  guard capture(async fn() {
      @decision_kit.resolve(
        request,
        cache_dir~,
        ttl=60,
        now=1000,
        remote=failed,
      )
    })
    is Err(@decision_kit.TransportFailed) else {
    fail("Expected an explicit transport failure")
  }
  for
    body in [
      b"\xff", b"{\"error\":false,\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":0}]}",
      b"{\"model\":\"other\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":0}]}",
      b"{\"model\":\"gpt-6-luna\",\"answers\":[]}", b"{\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":1},{}]}",
      b"{\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"wrong\",\"type\":\"predicate\",\"probability\":0}]}",
      b"{\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"score\",\"probability\":0}]}",
      b"{\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":-1}]}",
      b"{\"model\":\"gpt-6-luna\",\"answers\":[{\"name\":\"accurate\",\"type\":\"predicate\",\"probability\":\"1\"}]}",
    ] {
    let remote = @decision_kit.Remote::new("test-token", transport=fn(_, _, _) {
      (200, body)
    })
    guard capture(async fn() {
        @decision_kit.resolve(request, cache_dir~, ttl=60, now=1000, remote~)
      })
      is Err(@decision_kit.InvalidResponse) else {
      fail("Expected malformed response rejection")
    }
  }
  @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [])
}
