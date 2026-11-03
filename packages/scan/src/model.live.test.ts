import { describe, expect, it } from "vitest";
import { anthropicModel } from "./model.js";

// Gated live suite: this is the ground truth for the recorded contract tests. It calls the
// real Anthropic API and asserts the response shape our code depends on. It costs money and
// needs network, so it is SKIPPED unless both are set:
//   RUN_LIVE_LLM=1  ANTHROPIC_API_KEY=sk-...  [ANTHROPIC_MODEL=claude-...]
// CI never sets RUN_LIVE_LLM, so this never runs there by default. Run it before a release,
// or after an SDK/API bump, to confirm the contract — and to refresh test-fixtures/llm/ if
// it drifts.

const live = process.env.RUN_LIVE_LLM === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

const bundle = [
  {
    id: "doc:1",
    kind: "doc_excerpt",
    locator: "README.md:1",
    summary: "A service with user login.",
  },
  { id: "route:1", kind: "route", locator: "src/auth.ts:10", summary: "POST /login handler" },
  { id: "test:1", kind: "test_result", locator: "src/auth.test.ts", summary: "login test passed" },
];

describe.skipIf(!live)("anthropicModel against the live API", () => {
  it("proposes features that cite only bundle ids, with usage", async () => {
    const m = anthropicModel({ apiKey: process.env.ANTHROPIC_API_KEY, model, timeoutMs: 120_000 });
    const { proposal, usage } = await m.proposeFeatures(bundle);
    expect(Array.isArray(proposal.features)).toBe(true);
    const ids = new Set(bundle.map((b) => b.id));
    for (const f of proposal.features) {
      expect(typeof f.name).toBe("string");
      for (const id of [...f.intent_evidence_ids, ...f.implementation_evidence_ids])
        expect(ids.has(id), `cited unknown id ${id}`).toBe(true);
    }
    expect(usage[0]?.model).toBeTruthy();
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
  }, 180_000);

  it("drafts a report with all five sections", async () => {
    const m = anthropicModel({ apiKey: process.env.ANTHROPIC_API_KEY, model, timeoutMs: 120_000 });
    const { draft } = await m.draftReport({
      bundle,
      features: [
        {
          name: "User login",
          status: "complete",
          reason: "route + passing test",
          evidence_ids: ["route:1", "test:1"],
        },
      ],
      checks: { tests: "pass" },
      health: { score: 0.9, excluded: [] },
    });
    for (const section of ["summary", "value", "features", "issues", "remaining"] as const)
      expect(Array.isArray(draft[section]), `missing section ${section}`).toBe(true);
  }, 180_000);
});
