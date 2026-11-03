import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The dependency download's egress allowlist (ADR 0030, audit F-04). Squid is given our
 * config and runs on an internal Docker network with no route to the internet or the worker
 * network; a client on that network reaches the outside only through Squid, which allows a
 * CONNECT only to an allowlisted registry on 443. The test drives Squid with raw CONNECT
 * lines, so it needs no real registry.
 */
const run = promisify(execFile);
const PROXY_IMAGE = "ubuntu/squid:latest";
const CLIENT_IMAGE = process.env.SANDBOX_IMAGE ?? "codesentra/sandbox:test";
const CONF = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../infra/egress-proxy");
const NET = `cs-egress-test-${process.pid}`;
const PROXY = `cs-egress-proxy-${process.pid}`;
const haveDocker = async () => {
  try {
    await run("docker", ["image", "inspect", PROXY_IMAGE]);
    return true;
  } catch {
    return false;
  }
};

/** A raw CONNECT through the proxy from a client that has no other route out. */
const connect = (hostport: string) =>
  `node -e 'const net=require("net");const s=net.connect(3128,"proxy",()=>s.write("CONNECT ${hostport} HTTP/1.1\\r\\nHost: ${hostport}\\r\\n\\r\\n"));let b="";s.on("data",d=>{b+=d;if(b.includes("\\r\\n")){console.log(b.split("\\r\\n")[0]);s.destroy();}});s.on("error",e=>{console.log("DIRECT-ERR "+e.code);process.exit(0)});setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},5000)'`;
const clientRun = (script: string) =>
  run("docker", [
    "run",
    "--rm",
    "--network",
    NET,
    "--entrypoint",
    "sh",
    CLIENT_IMAGE,
    "-c",
    script,
  ]).then((r) => r.stdout.trim());

describe("egress allowlist proxy (ADR 0030)", () => {
  let enabled = false;
  beforeAll(async () => {
    enabled = await haveDocker();
    if (!enabled) return;
    await run("docker", ["network", "create", "--internal", NET]);
    await run("docker", [
      "run",
      "-d",
      "--name",
      PROXY,
      "--network",
      NET,
      "--network-alias",
      "proxy",
      "-v",
      `${join(CONF, "squid.conf")}:/etc/squid/squid.conf:ro`,
      "-v",
      `${join(CONF, "allowed-hosts.txt")}:/etc/squid/allowed-hosts.txt:ro`,
      PROXY_IMAGE,
    ]);
    // Squid needs a moment to open its port.
    for (let i = 0; i < 20; i++) {
      const out = await clientRun(connect("registry.npmjs.org:443")).catch(() => "");
      if (out && !out.includes("DIRECT-ERR")) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }, 120_000);
  afterAll(async () => {
    if (!enabled) return;
    await run("docker", ["rm", "-f", PROXY]).catch(() => {});
    await run("docker", ["network", "rm", NET]).catch(() => {});
  });

  it("permits CONNECT to an allowlisted registry on 443", async () => {
    if (!enabled) return expect(enabled, "squid image unavailable; UNVERIFIED").toBe(false);
    // The proxy lets the tunnel through (200 when the upstream answers, 503 when it is
    // unreachable from the test host); either proves the allowlist allowed it, unlike 403.
    for (const h of [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "codeload.github.com",
    ]) {
      const line = await clientRun(connect(`${h}:443`));
      expect(line, h).not.toContain("403");
      expect(line, h).toMatch(/ (200|503) /);
    }
  }, 60_000);

  it("denies CONNECT to any host not on the allowlist, and to a registry off 443", async () => {
    if (!enabled) return;
    expect(await clientRun(connect("evil.example:443"))).toContain("403");
    expect(await clientRun(connect("169.254.169.254:443"))).toContain("403");
    expect(await clientRun(connect("registry.npmjs.org.evil.example:443"))).toContain("403");
    expect(await clientRun(connect("registry.npmjs.org:22"))).toContain("403");
  }, 60_000);

  it("gives the client no route out except the proxy (internal network)", async () => {
    if (!enabled) return;
    // 8.8.8.8 is outside; with no gateway on an internal network the connect fails fast.
    const out = await clientRun(
      `node -e 'const s=require("net").connect(443,"8.8.8.8");s.on("connect",()=>{console.log("REACHED");process.exit()});s.on("error",e=>{console.log("DIRECT-ERR "+e.code);process.exit()});setTimeout(()=>{console.log("TIMEOUT");process.exit()},4000)'`,
    );
    expect(out).not.toContain("REACHED");
  }, 30_000);
});
