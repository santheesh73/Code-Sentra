import { lookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const all = await lookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface FetchPolicy {
  /**
   * Hostnames or IP literals exempt from the address check. Only ever non-empty in
   * tests (the fixture harness listens on loopback); see testPolicy().
   */
  readonly allowHosts: ReadonlySet<string>;
  readonly resolver: Resolver;
  /** Extra trusted CA certificates (PEM), e.g. the harness's throwaway CA in tests. */
  readonly ca?: string;
  readonly userAgent: string;
}

export const USER_AGENT = "CodeSentra-Pulse/0.1.0 (+https://codesentra.dev/pulse)";

export function defaultPolicy(
  overrides: Partial<Pick<FetchPolicy, "resolver" | "userAgent">> = {},
): FetchPolicy {
  return {
    allowHosts: new Set(),
    resolver: overrides.resolver ?? systemResolver,
    userAgent: overrides.userAgent ?? USER_AGENT,
  };
}

/**
 * A policy that lets the given loopback hosts through. Refuses to exist in production:
 * NODE_ENV must be "test" (ADR 0013).
 */
export function testPolicy(
  hosts: Iterable<string>,
  opts: { ca?: string; resolver?: Resolver; env?: Record<string, string | undefined> } = {},
): FetchPolicy {
  const env = opts.env ?? process.env;
  if (env.NODE_ENV !== "test") {
    throw new Error("testPolicy() is only available when NODE_ENV=test");
  }
  return {
    allowHosts: new Set([...hosts].map((h) => h.toLowerCase())),
    resolver: opts.resolver ?? systemResolver,
    ca: opts.ca,
    userAgent: USER_AGENT,
  };
}
