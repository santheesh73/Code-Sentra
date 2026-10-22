import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Harness, startHarness } from "@codesentra/fixture-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAddress } from "./address.js";
import { resolveTarget, SafeFetchError, safeFetch } from "./fetch.js";
import { HostLimiter } from "./limiter.js";
import { defaultPolicy, type Resolver, testPolicy } from "./policy.js";

async function errorOf(p: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SafeFetchError) return e;
    throw e;
  }
  throw new Error("expected a SafeFetchError");
}

describe("checkAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "100.64.0.1", // CGNAT
    "100.100.100.200", // Alibaba metadata
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "192.0.2.1", // TEST-NET-1
    "198.18.0.1", // benchmarking
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    "ff02::1",
  ];
  it.each(blocked)("blocks %s", (ip) => {
    expect(checkAddress(ip).allowed).toBe(false);
  });
  it.each(["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"])(
    "allows %s",
    (ip) => {
      expect(checkAddress(ip).allowed).toBe(true);
    },
  );
  it("rejects non-IPs", () => {
    expect(checkAddress("not-an-ip").allowed).toBe(false);
  });
});

describe("resolveTarget", () => {
  const policy = defaultPolicy();

  it.each([
    "http://2130706433/", // decimal 127.0.0.1
    "http://0177.0.0.1/", // octal
    "http://0x7f.0.0.1/", // hex
    "http://127.1/", // short form
    "http://017700000001/", // octal integer
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:169.254.169.254]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0x a9fe a9fe/".replace(/ /g, ""),
    "http://localhost:4000/data",
    "http://LOCALHOST./",
    "http://app.localhost/",
  ])("blocks %s", async (url) => {
    const e = await errorOf(resolveTarget(url, policy));
    expect(e.code).toBe("blocked_address");
  });

  it.each([
    "file:///etc/passwd",
    "gopher://example.com/",
    "ftp://example.com/",
    "javascript:alert(1)",
  ])("refuses scheme %s", async (url) => {
    expect((await errorOf(resolveTarget(url, policy))).code).toBe("invalid_url");
  });

  it("refuses credentials in URLs", async () => {
    expect((await errorOf(resolveTarget("https://user:pw@example.com/", policy))).code).toBe(
      "invalid_url",
    );
  });

  it("fails a host when any of its addresses is private (DNS rebinding)", async () => {
    const resolver: Resolver = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const e = await errorOf(resolveTarget("https://rebind.example/", defaultPolicy({ resolver })));
    expect(e.code).toBe("blocked_address");
  });

  it("reports DNS failures", async () => {
    const e = await errorOf(resolveTarget("http://nothing-here.codesentra-test.invalid/", policy));
    expect(e.code).toBe("dns_failure");
  });

  it("testPolicy cannot be created outside tests", () => {
    expect(() => testPolicy(["127.0.0.1"], { env: { NODE_ENV: "production" } })).toThrow(
      /NODE_ENV=test/,
    );
    expect(() => testPolicy(["127.0.0.1"], { env: {} })).toThrow();
  });
});

describe("safeFetch against local servers", () => {
  let server: Server;
  let base: string;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      if (path === "/to-mapped") {
        res.writeHead(302, { location: "http://[::ffff:a9fe:a9fe]/" });
        return res.end();
      }
      if (path === "/to-localhost") {
        res.writeHead(301, { location: `http://localhost:${port}/` });
        return res.end();
      }
      if (path === "/to-file") {
        res.writeHead(302, { location: "file:///etc/passwd" });
        return res.end();
      }
      if (path === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("x".repeat(10_000));
      }
      if (path === "/cookie") {
        res.writeHead(200, { "set-cookie": "sid=secret", "x-ok": "1" });
        return res.end("ok");
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello ${req.headers["user-agent"]}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const policy = () => testPolicy(["127.0.0.1"]);

  it("refuses loopback without an explicit test allowance", async () => {
    expect((await errorOf(safeFetch(base, { policy: defaultPolicy() }))).code).toBe(
      "blocked_address",
    );
  });

  it("fetches an allowed host and identifies itself", async () => {
    const res = await safeFetch(`${base}/`, { policy: policy() });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toMatch(/^hello CodeSentra-Pulse\//);
    expect(res.ip).toBe("127.0.0.1");
  });

  it("re-validates every redirect hop: metadata, IPv4-mapped IPv6 and non-allowlisted loopback", async () => {
    for (const path of ["/to-metadata", "/to-mapped", "/to-localhost"]) {
      const e = await errorOf(safeFetch(`${base}${path}`, { policy: policy() }));
      expect(e.code, path).toBe("blocked_address");
      expect(e.hops).toHaveLength(1);
      expect(e.hops[0]?.status).toBeGreaterThanOrEqual(301);
    }
  });

  it("refuses redirects to other schemes", async () => {
    expect((await errorOf(safeFetch(`${base}/to-file`, { policy: policy() }))).code).toBe(
      "invalid_url",
    );
  });

  it("pins the resolved address: the socket goes where the checked lookup said", async () => {
    let calls = 0;
    const resolver: Resolver = async (host) => {
      calls++;
      expect(host).toBe("pinned.codesentra.test");
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const p = testPolicy(["pinned.codesentra.test"], { resolver });
    const res = await safeFetch(`http://pinned.codesentra.test:${port}/`, { policy: p });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("caps the body", async () => {
    const res = await safeFetch(`${base}/big`, { policy: policy(), maxBodyBytes: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(1000);
  });

  it("never keeps cookies", async () => {
    const res = await safeFetch(`${base}/cookie`, { policy: policy() });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-ok"]).toBe("1");
  });
});

describe("safeFetch against the fixture harness simulators", () => {
  let h: Harness;
  const SLOW = 400;
  beforeAll(async () => {
    h = await startHarness({ slowMs: SLOW });
  });
  afterAll(async () => h?.close());
  const policy = () => testPolicy(["127.0.0.1", "localhost"], { ca: h.caCertPem });
  const sim = (name: keyof Harness["targets"]["simulators"]) => h.targets.simulators[name].url;

  it("records a full redirect chain", async () => {
    const res = await safeFetch(sim("long-redirect-chain"), { policy: policy() });
    expect(res.status).toBe(200);
    expect(res.hops.map((x) => x.status)).toEqual([301, 301, 301, 301, 301, 200]);
  });

  it("stops redirect loops and over-long chains", async () => {
    expect((await errorOf(safeFetch(sim("redirect-loop"), { policy: policy() }))).code).toBe(
      "redirect_loop",
    );
    const e = await errorOf(
      safeFetch(sim("long-redirect-chain"), { policy: policy(), maxRedirects: 3 }),
    );
    expect(e.code).toBe("too_many_redirects");
    expect(e.hops).toHaveLength(4);
  });

  it("classifies timeouts, refused connections and DNS failures", async () => {
    expect(
      (await errorOf(safeFetch(sim("timeout"), { policy: policy(), timeoutMs: 400 }))).code,
    ).toBe("timeout");
    expect((await errorOf(safeFetch(sim("connection-refused"), { policy: policy() }))).code).toBe(
      "connection",
    );
    expect((await errorOf(safeFetch(sim("dns-failure"), { policy: policy() }))).code).toBe(
      "dns_failure",
    );
  });

  it("measures time to first byte", async () => {
    const res = await safeFetch(sim("slow"), { policy: policy() });
    expect(res.timings.ttfbMs).toBeGreaterThanOrEqual(SLOW - 20);
  });

  it("reports TLS validity and expiry", async () => {
    const ok = await safeFetch(sim("tls-valid"), { policy: policy() });
    expect(ok.tls?.authorized).toBe(true);
    expect(ok.tls?.daysRemaining).toBeGreaterThan(300);
    const expiring = await safeFetch(sim("tls-expiring"), { policy: policy() });
    expect(expiring.tls?.authorized).toBe(true);
    expect(expiring.tls?.daysRemaining).toBeLessThan(14);
  });

  it.each(["tls-expired", "tls-wrong-host", "tls-self-signed"] as const)(
    "rejects %s with certificate details",
    async (name) => {
      const e = await errorOf(safeFetch(sim(name), { policy: policy() }));
      expect(e.code).toBe("tls_invalid");
      expect(e.tls?.authorized).toBe(false);
      expect(e.tls?.error).toBeTruthy();
    },
  );

  it("rejects the harness certificates when its CA is not trusted", async () => {
    const e = await errorOf(safeFetch(sim("tls-valid"), { policy: testPolicy(["localhost"]) }));
    expect(e.code).toBe("tls_invalid");
  });
});

describe("HostLimiter", () => {
  it("bounds per-host concurrency", async () => {
    const limiter = new HostLimiter(2, 0);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run("a.example", async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
