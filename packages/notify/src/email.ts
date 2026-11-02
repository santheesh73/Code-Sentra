import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  readonly kind: "resend" | "outbox" | "smtp";
  send(message: EmailMessage): Promise<void>;
}

/** Production transport: Resend HTTP API (ADR 0010). */
export function resendTransport(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    kind: "resend",
    async send(m) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Body may echo the address; log status only.
        throw new Error(`email provider returned ${res.status}`);
      }
    },
  };
}

/**
 * Development/test transport: writes each message as JSON into a directory. Refused in
 * production by packages/config. Lets local sign-in and e2e tests work without an
 * email account.
 */
export function outboxTransport(dir: string): EmailTransport {
  return {
    kind: "outbox",
    async send(m) {
      await mkdir(dir, { recursive: true });
      const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
      await writeFile(
        join(dir, name),
        JSON.stringify({ ...m, sentAt: new Date().toISOString() }, null, 2),
        {
          mode: 0o600,
        },
      );
    },
  };
}

/**
 * Development transport: hands each message to a local SMTP server (Mailpit) so a developer
 * can read sign-in mail in a web inbox, and e2e can read it over Mailpit's API. Plain SMTP on
 * localhost, no auth, no TLS — for a trusted local server only; packages/config refuses it in
 * production. A tiny client, so there is no mail dependency in the tree.
 */
export function smtpTransport(host: string, port: number, from: string): EmailTransport {
  return {
    kind: "smtp",
    async send(m) {
      const { createConnection } = await import("node:net");
      const socket = createConnection({ host, port });
      socket.setEncoding("utf8");
      socket.setTimeout(10_000);
      const boundary = `cs_${randomBytes(8).toString("hex")}`;
      // SMTP uses CRLF line endings throughout; normalize the parts' own newlines first.
      const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
      const body = [
        `From: ${from}`,
        `To: ${m.to}`,
        `Subject: ${m.subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        crlf(m.text),
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        crlf(m.html),
        `--${boundary}--`,
        "",
      ].join("\r\n");
      // SMTP forbids a bare "." line in the body; dot-stuff it (RFC 5321 §4.5.2).
      const dotStuffed = body.replace(/\r\n\./g, "\r\n..");
      const steps = [
        `EHLO codesentra\r\n`,
        `MAIL FROM:<${from}>\r\n`,
        `RCPT TO:<${m.to}>\r\n`,
        "DATA\r\n",
        `${dotStuffed}\r\n.\r\n`,
        "QUIT\r\n",
      ];
      await new Promise<void>((resolve, reject) => {
        let i = -1; // -1: awaiting the 220 greeting
        const fail = (e: Error) => {
          socket.destroy();
          reject(e);
        };
        socket.on("timeout", () => fail(new Error("smtp timeout")));
        socket.on("error", fail);
        socket.on("data", (chunk: string) => {
          const code = Number(chunk.slice(0, 3));
          if (code >= 400)
            return fail(new Error(`smtp server replied ${chunk.trim().slice(0, 80)}`));
          i += 1;
          if (i < steps.length) socket.write(steps[i] as string);
          else resolve();
        });
      });
    },
  };
}

/** In-memory transport for unit tests. */
export function memoryTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    kind: "outbox",
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}
