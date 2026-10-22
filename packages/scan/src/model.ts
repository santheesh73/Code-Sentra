import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * The model's two jobs (Section 8.5–8.6), both over an evidence bundle and both returning
 * only evidence keys, never numbers or statuses: propose features, and draft report
 * claims. Its output is validated, then classified and verified deterministically.
 */
export const ModelFeatureProposal = z.object({
  features: z
    .array(
      z.object({
        name: z.string(),
        intent_evidence_ids: z.array(z.string()),
        implementation_evidence_ids: z.array(z.string()),
      }),
    )
    .max(200),
});
export type ModelFeatureProposal = z.infer<typeof ModelFeatureProposal>;

const Claims = z.array(z.object({ text: z.string(), evidence_ids: z.array(z.string()) })).max(100);
export const ModelReportDraft = z.object({
  summary: Claims,
  value: Claims,
  features: Claims,
  issues: Claims,
  remaining: Claims,
});
export type ModelReportDraft = z.infer<typeof ModelReportDraft>;

export interface BundleItem {
  id: string;
  kind: string;
  locator: string;
  /** Compact summary of the payload (never secret values). */
  summary: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ReportModel {
  readonly name: string;
  proposeFeatures(
    bundle: BundleItem[],
  ): Promise<{ proposal: ModelFeatureProposal; usage: Usage[] }>;
  draftReport(input: {
    bundle: BundleItem[];
    features: { name: string; status: string; reason: string; evidence_ids: string[] }[];
    checks: Record<string, string>;
    health: { score: number | null; excluded: string[] };
  }): Promise<{ draft: ModelReportDraft; usage: Usage[] }>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly usage: Usage[] = [],
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const PROPOSE = `You are mapping a software project's features from evidence collected by deterministic tools.
Each evidence item has an id, kind, locator and summary. Intent evidence (doc_excerpt, manifest) says what the project means to do; implementation evidence (route, code_fact) shows code that does it; test_result items are tests.

Propose the project's user-facing features. For each, give a short name and the ids of the evidence that supports it:
- intent_evidence_ids: doc_excerpt/manifest ids that describe the feature;
- implementation_evidence_ids: route/code_fact ids for the code that implements it (include the files that hold its core logic, not only the route), plus test_result ids of tests that exercise it.
Only use ids from the bundle. Do not decide whether a feature is complete; that is computed from the evidence afterwards. A documented feature with no implementation evidence is still listed, with an empty implementation list.`;

const DRAFT = `You are writing a project report from evidence collected by deterministic tools. Every sentence is a claim that must cite the evidence ids it rests on; a separate verifier drops any claim whose concrete details (file paths, names, routes, env vars, versions, numbers) do not appear in the cited evidence, any claim about a feature whose status words disagree with the computed status, and any claim that a check passed when it did not.

Write short, factual claims in these sections:
- summary: what the project is;
- value: why it is useful and to whom;
- features: one claim per feature, stating its computed status (complete, partial or planned) and why;
- issues: problems found (failing tests, vulnerabilities, exposed secrets, undocumented env vars, markers);
- remaining: what is left to do.
Use the provided feature statuses, check outcomes and health score exactly; never compute or invent numbers. Prefer one concrete claim per sentence. Cite only ids from the bundle.`;

/** Anthropic Claude as the report model. Model from ANTHROPIC_MODEL (Section 3). */
export function anthropicModel(opts: {
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  client?: Anthropic;
}): ReportModel {
  const client =
    opts.client ??
    new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      timeout: opts.timeoutMs ?? 300_000,
      maxRetries: 2,
    });

  async function ask<T extends z.ZodTypeAny>(
    system: string,
    payload: unknown,
    schema: T,
  ): Promise<{ value: z.infer<T>; usage: Usage[] }> {
    const usage: Usage[] = [];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: JSON.stringify(payload) }];
    // One repair retry on invalid output, then fail the step with a gap (Section 19).
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.messages.parse({
        model: opts.model,
        max_tokens: 16000,
        system,
        messages,
        output_config: { format: zodOutputFormat(schema), effort: "high" },
      });
      usage.push({
        model: res.model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      });
      if (res.stop_reason === "refusal")
        throw new ModelError(
          `the model declined (${res.stop_details?.category ?? "no category"})`,
          usage,
        );
      const parsed = schema.safeParse(res.parsed_output);
      if (res.stop_reason !== "max_tokens" && parsed.success) return { value: parsed.data, usage };
      messages.push(
        { role: "assistant", content: res.content },
        {
          role: "user",
          content:
            res.stop_reason === "max_tokens"
              ? "The output was cut off. Return the complete JSON again, with shorter claims."
              : "The output did not match the schema. Return valid JSON matching it exactly.",
        },
      );
    }
    throw new ModelError("the model did not return valid output after one repair attempt", usage);
  }

  return {
    name: opts.model,
    async proposeFeatures(bundle) {
      const { value, usage } = await ask(PROPOSE, { evidence: bundle }, ModelFeatureProposal);
      return { proposal: value, usage };
    },
    async draftReport(input) {
      const { value, usage } = await ask(DRAFT, input, ModelReportDraft);
      return { draft: value, usage };
    },
  };
}
