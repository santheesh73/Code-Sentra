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
  readonly kind: "resend" | "outbox";
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
