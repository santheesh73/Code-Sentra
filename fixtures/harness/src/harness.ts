import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect, type Socket } from "node:net";
import { join } from "node:path";
import { type CertPair, createTestPki } from "./certs.js";
import { type FixtureApp, loadFixtureApps } from "./manifest.js";
import { FIXTURE_SECURITY_HEADERS, serveExport } from "./static-server.js";

/** The bypass secret the access-protected simulator accepts (tests only). */
export const ACCESS_PROTECTED_BYPASS = "cs-test-bypass-0123456789abcdef";

export const SIMULATORS = [
  "server-error",
  "service-unavailable",
  "not-found",
  "timeout",
  "slow",
  "redirect-loop",
  "long-redirect-chain",
  "connection-refused",
  "dns-failure",
  "tls-valid",
  "tls-expiring",
  "tls-expired",
  "tls-wrong-host",
  "tls-self-signed",
  "access-protected",
  "preview-deployment",
] as const;
export type SimulatorName = (typeof SIMULATORS)[number];

export interface SimulatorTarget {
  url: string;
  /** The Pulse outcome this target exists to produce. */
  produces: string;
}

export interface HarnessTargets {
  apps: Record<string, { url: string; variant: string; variants: string[] }>;
  simulators: Record<SimulatorName, SimulatorTarget>;
  control: string;
}

export interface HarnessOptions {
  /** Bind address. Defaults to 127.0.0.1; the harness is never exposed beyond the host by default. */
  host?: string;
  /** Host name used in advertised URLs (e.g. "localhost" when bound to 0.0.0.0 in a container). */
  publicHost?: string;
  /** If set, servers bind sequential ports from here; otherwise ephemeral ports. */
  basePort?: number;
  /** Delay for the `slow` simulator, ms (Pulse SLOW_RESPONSE default threshold is 3000). */
  slowMs?: number;
  apps?: FixtureApp[];
  log?: (line: string) => void;
}

export interface Harness {
  targets: HarnessTargets;
  /** PEM of the throwaway CA that signs the tls-* simulators (except tls-self-signed). */
  caCertPem: string;
  setVariant(app: string, variant: string): void;
  close(): Promise<void>;
}

const HTML = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>CodeSentra fixture harness simulator.</p></main></body></html>`;

function sendHtml(res: ServerResponse, status: number, title: string): void {
  for (const [k, v] of Object.entries(FIXTURE_SECURITY_HEADERS)) res.setHeader(k, v);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(HTML(title));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * A port on `host` that refuses connections. Privileged ports are never handed out as
 * ephemeral ports, so no other process can start listening on one mid-test (a closed
 * ephemeral port can be reused by a parallel test). Each candidate is probed first.
 */
async function refusedPort(host: string): Promise<number> {
  for (const port of [9, 1, 47, 59, 61]) {
    const refused = await new Promise<boolean>((ok) => {
      const sock = connect({ host, port });
      sock.setTimeout(1000);
      sock.once("connect", () => {
        sock.destroy();
        ok(false);
      });
      sock.once("timeout", () => {
        sock.destroy();
        ok(false);
      });
      sock.once("error", (e: NodeJS.ErrnoException) => ok(e.code === "ECONNREFUSED"));
    });
    if (refused) return port;
  }
  throw new Error(`no refusing port found on ${host}`);
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const host = opts.host ?? "127.0.0.1";
  const publicHost = opts.publicHost ?? (host === "0.0.0.0" ? "localhost" : host);
  const slowMs = opts.slowMs ?? 3500;
  const log = opts.log ?? (() => {});
  const apps = opts.apps ?? loadFixtureApps();
  const pki = createTestPki();
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let nextPort = opts.basePort;

  const listen = async (server: Server): Promise<number> => {
    server.on("connection", (s: Socket) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    servers.push(server);
    const port = nextPort === undefined ? 0 : nextPort++;
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(port, host, () => ok());
    });
    return (server.address() as AddressInfo).port;
  };
  const httpUrl = (port: number, path = "/") => `http://${publicHost}:${port}${path}`;
  const http = async (handler: Handler) => httpUrl(await listen(createServer(handler)));
  const https = async (pair: CertPair) => {
    const port = await listen(
      createHttpsServer({ cert: pair.certPem, key: pair.keyPem }, (_req, res) =>
        sendHtml(res, 200, "TLS simulator"),
      ),
    );
    return `https://${publicHost === "127.0.0.1" ? "localhost" : publicHost}:${port}/`;
  };

  // --- Fixture apps -------------------------------------------------------
  const variantOf = new Map<string, string>();
  const appTargets: HarnessTargets["apps"] = {};
  for (const app of apps) {
    const { manifest } = app;
    for (const [variant, v] of Object.entries(manifest.variants)) {
      if (!existsSync(join(app.dir, v.outDir, "index.html"))) {
        throw new Error(
          `Fixture ${manifest.name} variant ${variant} is not built (${v.outDir}/index.html missing). Run: pnpm fixtures:build`,
        );
      }
    }
    variantOf.set(manifest.name, manifest.defaultVariant);
    const url = await http((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const backend = manifest.backendRoutes[path];
      if (backend) {
        for (const [k, val] of Object.entries(FIXTURE_SECURITY_HEADERS)) res.setHeader(k, val);
        res.writeHead(backend.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(backend.json));
        return;
      }
      const variant = variantOf.get(manifest.name) ?? manifest.defaultVariant;
      const outDir = manifest.variants[variant]?.outDir ?? "out";
      serveExport(join(app.dir, outDir), req, res);
    });
    appTargets[manifest.name] = {
      url,
      variant: manifest.defaultVariant,
      variants: Object.keys(manifest.variants),
    };
  }

  // --- Simulators ---------------------------------------------------------
  const sim = {} as Record<SimulatorName, SimulatorTarget>;
  sim["server-error"] = {
    url: await http((_q, r) => sendHtml(r, 500, "Internal Server Error")),
    produces: "SERVER_ERROR, status down",
  };
  sim["service-unavailable"] = {
    url: await http((_q, r) => sendHtml(r, 503, "Service Unavailable")),
    produces: "SERVER_ERROR, status down",
  };
  sim["not-found"] = {
    url: await http((_q, r) => sendHtml(r, 404, "Not Found")),
    produces: "BAD_STATUS",
  };
  sim["access-protected"] = {
    // Vercel Deployment Protection's wall: 401 from Vercel's edge.
    url: await http((q, r) => {
      r.setHeader("server", "Vercel");
      r.setHeader("x-vercel-id", "sim1::protected");
      // Vercel's "Protection Bypass for Automation": the right secret gets the page.
      if (q.headers["x-vercel-protection-bypass"] === ACCESS_PROTECTED_BYPASS)
        return sendHtml(r, 200, "Protected preview, reached with the bypass secret");
      sendHtml(r, 401, "Authentication Required");
    }),
    produces:
      "ACCESS_PROTECTED; render, routes and hygiene not checked (unverified); live with the bypass header",
  };
  sim["preview-deployment"] = {
    // A healthy page served by Vercel. Reached as <project>-git-<branch>-<scope>.vercel.app
    // through a test resolver, it is a preview deployment.
    url: await http((_q, r) => {
      r.setHeader("server", "Vercel");
      r.setHeader("x-vercel-id", "sim1::preview");
      sendHtml(r, 200, "Preview deployment");
    }),
    produces:
      "PREVIEW_SERVED_AS_PROD when registered as production and reached via a *-git-*.vercel.app name",
  };
  sim.timeout = {
    // Accepts the connection, never answers.
    url: await http(() => {}),
    produces: "TIMEOUT, status down",
  };
  sim.slow = {
    url: await http((_q, r) => {
      const t = setTimeout(() => {
        timers.delete(t);
        sendHtml(r, 200, "Slow");
      }, slowMs);
      timers.add(t);
    }),
    produces: `SLOW_RESPONSE (TTFB ~${slowMs} ms)`,
  };
  sim["redirect-loop"] = {
    url: await http((q, r) => {
      const p = new URL(q.url ?? "/", "http://x").pathname;
      r.writeHead(302, { location: p === "/loop-a" ? "/loop-b" : "/loop-a" });
      r.end();
    }),
    produces: "REDIRECT_LOOP",
  };
  sim["long-redirect-chain"] = {
    url: await http((q, r) => {
      const p = new URL(q.url ?? "/", "http://x").pathname;
      const hop = p === "/" ? 0 : Number(/^\/hop\/(\d+)$/.exec(p)?.[1] ?? -1);
      if (hop >= 0 && hop < 5) {
        r.writeHead(301, { location: `/hop/${hop + 1}` });
        r.end();
        return;
      }
      sendHtml(r, hop === 5 ? 200 : 404, hop === 5 ? "End of chain" : "Not Found");
    }),
    produces: "LONG_REDIRECT_CHAIN (5 hops)",
  };
  sim["connection-refused"] = {
    url: httpUrl(await refusedPort(host)),
    produces: "DOWN (connection refused)",
  };
  // RFC 2606: .invalid never resolves.
  sim["dns-failure"] = {
    url: "http://dns-failure.codesentra-fixture.invalid/",
    produces: "DNS_FAILURE, status down",
  };
  sim["tls-valid"] = {
    url: await https(pki.valid),
    produces: "valid TLS when the harness CA is trusted",
  };
  sim["tls-expiring"] = {
    url: await https(pki.expiring),
    produces: "TLS_EXPIRING (7 days) when the harness CA is trusted",
  };
  sim["tls-expired"] = { url: await https(pki.expired), produces: "TLS_INVALID (expired)" };
  sim["tls-wrong-host"] = {
    url: await https(pki.wrongHost),
    produces: "TLS_INVALID (host mismatch)",
  };
  sim["tls-self-signed"] = {
    url: await https(pki.selfSigned),
    produces: "TLS_INVALID (untrusted issuer)",
  };

  const setVariant = (app: string, variant: string) => {
    const target = appTargets[app];
    if (!target) throw new Error(`Unknown fixture app: ${app}`);
    if (!target.variants.includes(variant)) {
      throw new Error(
        `Fixture ${app} has no variant ${variant} (has: ${target.variants.join(", ")})`,
      );
    }
    variantOf.set(app, variant);
    target.variant = variant;
    log(`variant ${app} -> ${variant}`);
  };

  // --- Control ------------------------------------------------------------
  const targets: HarnessTargets = { apps: appTargets, simulators: sim, control: "" };
  targets.control = await http((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.method === "GET" && url.pathname === "/__harness/targets") {
      json(200, targets);
      return;
    }
    if (req.method === "GET" && url.pathname === "/__harness/ca.pem") {
      res.writeHead(200, { "content-type": "application/x-pem-file" });
      res.end(pki.ca.certPem);
      return;
    }
    const m = /^\/__harness\/apps\/([a-z0-9-]+)\/variant$/.exec(url.pathname);
    if (req.method === "POST" && m?.[1]) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        try {
          const { variant } = JSON.parse(body) as { variant?: unknown };
          if (typeof variant !== "string") throw new Error('body must be {"variant": string}');
          setVariant(m[1] as string, variant);
          json(200, appTargets[m[1] as string]);
        } catch (e) {
          json(400, { error: (e as Error).message });
        }
      });
      return;
    }
    json(404, { error: "not found" });
  });

  return {
    targets,
    caCertPem: pki.ca.certPem,
    setVariant,
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
    },
  };
}
