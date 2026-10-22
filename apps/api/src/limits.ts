import type { RunType } from "@codesentra/core";
import { schema as s } from "@codesentra/db";
import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import type { AppContext } from "./context.js";
import { tooManyRuns } from "./errors.js";

/**
 * Section 17 run limits. They are counted from the `runs` table, so they hold across any
 * number of API replicas and survive restarts. Link runs are not counted: each one is
 * started by the children it reports on.
 */
export interface RunLimits {
  /** Runs an org may start per hour, all types. */
  orgPerHour: number;
  /** Runs one user may start per hour (across their orgs). */
  userPerHour: number;
  /** Runs per org per hour, by type. */
  typePerHour: Partial<Record<RunType, number>>;
  /** Pulse runs against one target host per minute, across all orgs (protects the target). */
  hostPerMinute: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  orgPerHour: 300,
  userPerHour: 150,
  typePerHour: { scan: 60, pulse: 240, recheck: 120 },
  hostPerMinute: 30,
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** The host part of runs.target_url, the same way URL#host lowercases it. */
const targetHost = sql`lower(split_part(split_part(${s.runs.targetUrl}, '://', 2), '/', 1))`;

export async function enforceRunLimits(
  ctx: AppContext,
  input: { orgId: string; userId: string | null; types: RunType[]; targetUrls: string[] },
): Promise<void> {
  const limits = { ...DEFAULT_RUN_LIMITS, ...ctx.limits };
  const hourAgo = sql`now() - interval '1 hour'`;
  const minuteAgo = sql`now() - interval '1 minute'`;
  const n = input.types.length;
  const org = await ctx.db.withOrg(input.orgId, async (tx) => {
    const [all] = await tx
      .select({ n: count() })
      .from(s.runs)
      .where(and(ne(s.runs.type, "link"), gt(s.runs.createdAt, hourAgo)));
    const byType = await tx
      .select({ type: s.runs.type, n: count() })
      .from(s.runs)
      .where(gt(s.runs.createdAt, hourAgo))
      .groupBy(s.runs.type);
    return { all: all?.n ?? 0, byType: new Map(byType.map((r) => [r.type, r.n])) };
  });
  if (org.all + n > limits.orgPerHour)
    throw tooManyRuns(
      `This organization started ${org.all} runs in the last hour (limit ${limits.orgPerHour})`,
      3600,
    );
  for (const type of new Set(input.types)) {
    const max = limits.typePerHour[type];
    const want = input.types.filter((t) => t === type).length;
    const used = org.byType.get(type) ?? 0;
    if (max !== undefined && used + want > max)
      throw tooManyRuns(
        `This organization started ${used} ${type} runs in the last hour (limit ${max})`,
        3600,
      );
  }
  if (input.userId) {
    // Across every org the user belongs to: the runs table is read as the system role.
    const [mine] = await ctx.db.system
      .select({ n: count() })
      .from(s.runs)
      .where(
        and(
          eq(s.runs.requestedBy, input.userId),
          ne(s.runs.type, "link"),
          gt(s.runs.createdAt, hourAgo),
        ),
      );
    if ((mine?.n ?? 0) + n > limits.userPerHour)
      throw tooManyRuns(
        `You started ${mine?.n ?? 0} runs in the last hour (limit ${limits.userPerHour})`,
        3600,
      );
  }
  for (const host of new Set(input.targetUrls.map(hostOf).filter((h): h is string => !!h))) {
    const [hits] = await ctx.db.system
      .select({ n: count() })
      .from(s.runs)
      .where(and(sql`${targetHost} = ${host}`, gt(s.runs.createdAt, minuteAgo)));
    if ((hits?.n ?? 0) + 1 > limits.hostPerMinute)
      throw tooManyRuns(
        `${host} was checked ${hits?.n ?? 0} times in the last minute (limit ${limits.hostPerMinute})`,
        60,
      );
  }
}
