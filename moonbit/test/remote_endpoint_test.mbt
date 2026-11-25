///|
let pinned_proxy = "https://decision.proxy.test:8443/custom.predicates/v2/"

///|
test "a remote pin must be an unambiguous absolute HTTPS URL" {
  for
    url in [
      "http://proxy.test/decide", "https://proxy.test", "https://Proxy.test/decide",
      "https://proxy.test/decide?query=x", "https://proxy.test/decide#fragment",
      "https://user@proxy.test/decide", "https://proxy.test\\other.test/decide",
      "https://proxy.test/decide\n", "https://proxy.test/de cide", "https://proxy.test/./decide",
      "https://proxy.test/a/../decide", "https://proxy.test/%2fdecide", "https://proxy.test/%2E/decide",
      "https://proxy.test//decide", "https://proxy.test:0/decide", "https://proxy.test:0443/decide",
      "https://proxy.test:65536/decide", "https://proxy..test/decide", "https://proxy.test./decide",
      "https://0x7f000001/decide", "https://127.0.0.1/decide",
    ] {
    let result = Ok(@decision_kit.Remote::new("token", endpoint=url)) catch {
      err => Err(err)
    }
    guard result is Err(@decision_kit.InvalidEndpoint) else {
      fail("Expected a rejected remote pin: \{url}")
    }
  }
}

///|
async test "a separate Gateway token is rejected on every other authority" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  for
    url in [
      "https://api.cloudflare.com/client/v4/accounts/example/ai/run", "https://gateway.ai.cloudflare.com.evil.test/v1/example/team/jev",
      "https://gateway.ai.cloudflare.com:443/v1/example/team/jev", "https://api.typesafe.ai/v1/systemone",
    ] {
    let result = Ok(
      @decision_kit.Remote::new(
        "provider-token",
        endpoint=url,
        gateway_token="gateway-token",
      ),
    ) catch {
      err => Err(err)
    }
    guard result is Err(@decision_kit.InvalidEndpoint) else {
      fail("Gateway tokens require the exact Gateway authority")
    }
  }
  let transport : @decision_kit.Transport = fn(_, _, _) raise {
    fail("Never send the Gateway token to a direct provider")
  }
  let remote = @decision_kit.Remote::new(
    "provider-token",
    gateway_token="gateway-token",
    transport~,
  )
  guard capture(async fn() {
      @decision_kit.resolve(
        systemone_request(),
        cache_dir~,
        ttl=60,
        now=1000,
        remote~,
      )
    })
    is Err(@decision_kit.InvalidEndpoint) else {
    fail("Expected endpoint rejection for the unpinned token")
  }
}

///|
test "a separate Gateway token must be a single bearer value" {
  let result = Ok(
    @decision_kit.Remote::new(
      "provider-token",
      endpoint="https://gateway.ai.cloudflare.com/v1/example/team/type-safe",
      gateway_token="token\r\nInjected: header",
    ),
  ) catch {
    err => Err(err)
  }
  guard result is Err(@decision_kit.InvalidToken) else {
    fail("Expected invalid Gateway token rejection")
  }
}

///|
async test "unknown endpoints require a pin and a pin overrides standard endpoint trust" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let mut calls = 0
  let transport : @decision_kit.Transport = fn(_, _, _) {
    calls += 1
    (200, success)
  }
  let pins = [
    (pinned_proxy, @decision_kit.Remote::new("token", transport~)),
    (
      "https://decision.proxy.test:8443/custom.predicates/v2",
      @decision_kit.Remote::new("token", endpoint=pinned_proxy, transport~),
    ),
    (
      "https://api.openai.com/v1/decisions",
      @decision_kit.Remote::new("token", endpoint=pinned_proxy, transport~),
    ),
    (
      endpoint,
      @decision_kit.Remote::new("token", endpoint=pinned_proxy, transport~),
    ),
    (
      "https://api.typesafe.ai/v1/systemone",
      @decision_kit.Remote::new("token", transport~),
    ),
  ]
  for pair in pins {
    let (url, remote) = pair
    guard capture(async fn() {
        @decision_kit.resolve(
          request(endpoint=url),
          cache_dir~,
          ttl=60,
          now=1000,
          remote~,
        )
      })
      is Err(@decision_kit.InvalidEndpoint) else {
      fail("Expected endpoint rejection before transport: \{url}")
    }
  }
  @assertions.assert_eq(calls, 0)
}

///|
async test "OpenAI pin preserves the full proxy path and caching controls only remote cache headers" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  let request = request(endpoint=pinned_proxy)
  let key = request.key()
  let mut calls = 0
  let policies : Array[@decision_kit.RemoteCache?] = [
    None,
    Some(@decision_kit.RemoteCache::Cloudflare),
    Some(@decision_kit.RemoteCache::None),
  ]
  for index, policy in policies {
    let remote = @decision_kit.Remote::new(
      "test-token",
      endpoint=pinned_proxy,
      remote_cache?=policy,
      transport=fn(url, headers, body) raise {
        calls += 1
        @assertions.assert_eq(url, pinned_proxy)
        let expected = {
          "authorization": "Bearer test-token",
          "content-type": "application/json",
        }
        if policy is Some(@decision_kit.RemoteCache::Cloudflare) {
          expected["cf-aig-cache-key"] = "decision-v1-\{key}"
          expected["cf-aig-cache-ttl"] = "60"
          expected["cf-aig-skip-cache"] = "false"
        }
        @assertions.assert_eq(headers, expected)
        assert_true(body == request.body())
        (200, success)
      },
    )
    let now = 1000L + index.to_int64() * 60L
    inspect(
      @decision_kit.resolve(request, cache_dir~, ttl=60, now~, remote~),
      content="0.75",
    )
    inspect(
      @decision_kit.read_cached(request, cache_dir~, ttl=60, now~),
      content="0.75",
    )
    @assertions.assert_eq(@fs.readdir(cache_dir, include_hidden=true), [
      "\{key}.json",
    ])
  }
  @assertions.assert_eq(calls, 3)
}

///|
async test "standard OpenAI routes keep their authentication when cache headers are omitted" {
  let cache_dir = @fs.tmpdir(prefix="decision-kit")
  defer @fs.rmdir(cache_dir, recursive=true)
  for url in [endpoint, "https://api.openai.com/v1/decisions"] {
    let direct = url != endpoint
    let policy = if direct {
      None
    } else {
      Some(@decision_kit.RemoteCache::None)
    }
    let remote = @decision_kit.Remote::new("test-token", remote_cache?=policy, transport=fn(
      actual,
      headers,
      _,
    ) raise {
      @assertions.assert_eq(actual, url)
      let key = if direct { "authorization" } else { "cf-aig-authorization" }
      let expected = { "content-type": "application/json" }
      expected[key] = "Bearer test-token"
      @assertions.assert_eq(headers, expected)
      (200, success)
    })
    inspect(
      @decision_kit.resolve(
        request(endpoint=url),
        cache_dir~,
        ttl=60,
        now=1000,
        remote~,
      ),
      content="0.75",
    )
  }
}
