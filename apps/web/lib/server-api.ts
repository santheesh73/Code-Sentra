import "server-only";
import { loadConfig } from "@codesentra/config";
import { cookies } from "next/headers";
import type { Me } from "./api";

let cached: ReturnType<typeof loadConfig<"web">> | null = null;
export function webConfig() {
  cached ??= loadConfig("web");
  return cached;
}

/** Server-side read of the signed-in user, forwarding only the session cookie. */
export async function getMe(): Promise<Me | null> {
  const jar = await cookies();
  const session = jar.get("cs_session");
  if (!session) return null;
  const res = await fetch(new URL("/v1/me", webConfig().API_INTERNAL_URL), {
    headers: { cookie: `cs_session=${session.value}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`API /v1/me returned ${res.status}`);
  return (await res.json()) as Me;
}
