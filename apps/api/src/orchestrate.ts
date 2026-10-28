import { type StartLinkedInput, startLinked as start } from "@codesentra/queue";
import type { AppContext } from "./context.js";
import { enforceRunLimits } from "./limits.js";

export type { ChildRun } from "@codesentra/queue";

/**
 * Starts a Link run with its children (packages/queue `startLinked`, ADR 0019) after the
 * per-org, per-user, per-host and per-run-type limits (Section 17) allow it.
 */
export async function startLinked(ctx: AppContext, input: StartLinkedInput) {
  await enforceRunLimits(ctx, {
    orgId: input.orgId,
    userId: input.userId,
    types: input.children.map((c) => c.run.type),
    targetUrls: input.children.flatMap((c) => (c.run.targetUrl ? [c.run.targetUrl] : [])),
  });
  return start(ctx, input);
}
