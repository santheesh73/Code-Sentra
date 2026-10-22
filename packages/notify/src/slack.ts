/** Slack incoming webhooks are always on this host (https only). */
export const SLACK_WEBHOOK_HOST = "hooks.slack.com";

export function isSlackWebhookUrl(
  url: string,
  testHosts: ReadonlySet<string> = new Set(),
): boolean {
  try {
    const u = new URL(url);
    if (testHosts.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
    return (
      u.protocol === "https:" &&
      u.hostname === SLACK_WEBHOOK_HOST &&
      u.pathname.startsWith("/services/")
    );
  } catch {
    return false;
  }
}

/**
 * Posts a message to an incoming webhook. `fetchImpl` is the SSRF-safe fetch in workers.
 * The webhook URL is a secret: errors never include it.
 */
export async function postSlack(
  url: string,
  message: { text: string; blocks: unknown[] },
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`Slack returned ${res.status}`);
}

/** Exchanges an "Add to Slack" code for the incoming webhook it created (oauth.v2.access). */
export async function slackOauthExchange(input: {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; channel: string }> {
  const res = await (input.fetchImpl ?? fetch)(new URL("/api/oauth.v2.access", input.apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    incoming_webhook?: { url?: string; channel?: string };
  };
  if (!res.ok || !body.ok || !body.incoming_webhook?.url)
    throw new Error(`Slack OAuth failed: ${body.error ?? res.status}`);
  return { url: body.incoming_webhook.url, channel: body.incoming_webhook.channel ?? "Slack" };
}
