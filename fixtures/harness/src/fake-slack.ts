import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Slack as CodeSentra uses it: `oauth.v2.access` ("Add to Slack"
 * with the incoming-webhook scope) and the incoming webhooks it hands out. Messages
 * posted to a webhook are recorded.
 */
export interface FakeSlack {
  url: string;
  clientId: string;
  clientSecret: string;
  /** A code Slack would return after the user picked `channel`. */
  authorize(code: string, channel: string): void;
  messages: { channel: string; body: { text: string; blocks: unknown[] } }[];
  /** Makes the next webhook post answer this status (e.g. 500). */
  failNext(status: number): void;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString()));
  });

export async function startFakeSlack(): Promise<FakeSlack> {
  const clientId = "1234.5678";
  const clientSecret = randomBytes(16).toString("hex");
  const codes = new Map<string, string>();
  const hooks = new Map<string, string>();
  const messages: FakeSlack["messages"] = [];
  let fail: number | null = null;
  let base = "";
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/api/oauth.v2.access") {
      const form = new URLSearchParams(await readBody(req));
      const channel = codes.get(form.get("code") ?? "");
      if (
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret ||
        !channel
      )
        return json(200, { ok: false, error: "invalid_code" });
      codes.delete(form.get("code") as string);
      const hook = `/services/T0000/B0000/${randomBytes(12).toString("hex")}`;
      hooks.set(hook, channel);
      return json(200, { ok: true, incoming_webhook: { url: `${base}${hook}`, channel } });
    }
    const channel = hooks.get(path ?? "");
    if (req.method === "POST" && channel) {
      const body = JSON.parse(await readBody(req));
      if (fail) {
        const status = fail;
        fail = null;
        res.writeHead(status);
        return res.end("error");
      }
      messages.push({ channel, body });
      res.writeHead(200);
      return res.end("ok");
    }
    json(404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    clientId,
    clientSecret,
    messages,
    authorize: (code, channel) => void codes.set(code, channel),
    failNext: (status) => {
      fail = status;
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
