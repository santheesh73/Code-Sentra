import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type EmailMessage, smtpTransport } from "./email.js";

/** A tiny SMTP server that records the DATA body and replies to each command (Mailpit stand-in). */
function stubSmtp(): Promise<{ server: Server; port: number; received: Promise<string> }> {
  let resolveBody: (s: string) => void;
  const received = new Promise<string>((r) => (resolveBody = r));
  return new Promise((ok) => {
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      let inData = false;
      let body = "";
      sock.write("220 stub ESMTP\r\n");
      sock.on("data", (chunk: string) => {
        if (inData) {
          body += chunk;
          if (body.includes("\r\n.\r\n")) {
            inData = false;
            sock.write("250 OK queued\r\n");
            resolveBody(body.slice(0, body.indexOf("\r\n.\r\n")));
          }
          return;
        }
        for (const line of chunk.split("\r\n").filter(Boolean)) {
          if (/^EHLO|^HELO/i.test(line)) sock.write("250 stub\r\n");
          else if (/^MAIL FROM/i.test(line)) sock.write("250 OK\r\n");
          else if (/^RCPT TO/i.test(line)) sock.write("250 OK\r\n");
          else if (/^DATA/i.test(line)) {
            inData = true;
            sock.write("354 end with .\r\n");
          } else if (/^QUIT/i.test(line)) {
            sock.write("221 Bye\r\n");
            sock.end();
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () =>
      ok({ server, port: (server.address() as AddressInfo).port, received }),
    );
  });
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const msg: EmailMessage = {
  to: "dev@example.test",
  subject: "Sign in to CodeSentra",
  text: "Your link: https://app.test/magic/abc",
  html: "<p>Your link: <a href='https://app.test/magic/abc'>sign in</a></p>",
};

describe("smtpTransport (Mailpit, ADR 0035)", () => {
  it("delivers a multipart message to a local SMTP server", async () => {
    const { server, port, received } = await stubSmtp();
    servers.push(server);
    await smtpTransport("127.0.0.1", port, "codesentra@localhost").send(msg);
    const body = await received;
    expect(body).toContain("Subject: Sign in to CodeSentra");
    expect(body).toContain("To: dev@example.test");
    expect(body).toContain("multipart/alternative");
    expect(body).toContain("Your link: https://app.test/magic/abc");
    expect(body).toContain("<a href='https://app.test/magic/abc'>");
  });

  it("rejects when the server refuses a command", async () => {
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.write("220 stub\r\n");
      sock.on("data", () => sock.write("550 no\r\n"));
    });
    servers.push(server);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    await expect(smtpTransport("127.0.0.1", port, "x@localhost").send(msg)).rejects.toThrow(/smtp/);
  });

  it("dot-stuffs a line that is just a period so the body is not truncated", async () => {
    const { server, port, received } = await stubSmtp();
    servers.push(server);
    await smtpTransport("127.0.0.1", port, "x@localhost").send({
      ...msg,
      text: "line one\n.\nline three",
    });
    const body = await received;
    expect(body).toContain("line one\r\n..\r\nline three");
  });
});
