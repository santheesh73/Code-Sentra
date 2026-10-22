# 0013 — SSRF-safe fetch and the test-only loopback allowance

- **Status:** accepted (Phase 2)

## Decision

- **One fetch path.** Every request Pulse makes goes through `safeFetch` in
  `packages/ssrf`: reachability, routes, hygiene, and every browser request in the render
  check (ADR 0014). No other code in Pulse opens a socket to a target.
- **Address rule.** Only globally routable unicast addresses pass (`ipaddr.js` `range()`
  must be `unicast`). This refuses loopback, RFC 1918, link-local (including
  169.254.169.254), CGNAT (including 100.100.100.200), unique-local IPv6 (including
  fd00:ec2::254), multicast, reserved and unspecified addresses. It also refuses
  IPv4-mapped, 6to4, Teredo and NAT64 forms, which could carry a private IPv4. The names
  `localhost` and `*.localhost` are refused before DNS (RFC 6761), with or without a
  trailing dot.
- **DNS pinning.** A host is resolved once. _Every_ returned address must pass, and the
  connection is made to the first one through a custom `lookup`, so a second, rebinding
  answer is never used. TLS still verifies against the host name.
- **Redirects are manual.** Each hop is parsed, checked against the address rule, and
  resolved and pinned again. Loops and chains longer than 10 hops are failures
  (`redirect_loop`, `too_many_redirects`). Only http and https are followed. Cookies are
  never stored or sent.
- **Limits.** Per-request timeout (15 s by default), capped response bodies, GET/HEAD only,
  and a per-host concurrency limiter for politeness.
- **Blocked is not down.** A refused target makes the run `unverified`, with the gap
  stated, because nothing was contacted (Rule 2). The API also refuses IP-literal and
  `localhost` targets when a run is requested, for fast feedback. The worker stays the
  enforcement point, since only it sees the DNS answer.

## Test-only loopback allowance

The fixture apps and simulators run on 127.0.0.1, which the address rule refuses.
`testPolicy(hosts, { ca })` exempts the named hosts from the address rule (every other
check still applies) and trusts the harness's throwaway CA. It throws unless
`NODE_ENV=test`. The settings that enable it, `PULSE_TEST_ALLOW_HOSTS` and
`PULSE_TEST_CA_FILE`, are rejected by `packages/config` unless `NODE_ENV=test`, and the
CLI builds its policy with the same guard. A production deployment therefore cannot reach
loopback even when misconfigured.

## Consequences

- The SSRF suite (`packages/ssrf`, 70 tests) covers every refused range, rebinding via a
  fake resolver, redirect re-validation, and the allowance guard.
- Pulse cannot check intranet sites. That is intended.
