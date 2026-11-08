import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicModel, ModelError } from "./model.js";

// Recorded LLM contract tests: drive the real anthropicModel() with an injected client that
// replays recorded parse() responses (test-fixtures/llm/), so our half of the contract —
// request shape, happy-path parsing, refusal, the single repair retry, the final error —
// is exercised deterministically and offline. The gated live suite (model.live.test.ts) is
// the ground truth that these recordings mirror.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, "../test-fixtures/llm", name), "utf8"));

interface ParseCall {
  args: Anthropic.MessageCreateParamsNonStreaming;
}

/** A client whose messages.parse() returns the queued responses in order, recording each request. */
function fakeClient(responses: unknown[]): { client: Anthropic; calls: ParseCall[] } {
  const calls: ParseCall[] = [];
  let i = 0;
  const client = {
    messages: {
      parse: async (args: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push({ args });
        if (i >= responses.length) throw new Error("parse() called more times than recorded");
        return responses[i++];
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const bundle = [
  { id: "doc:1", kind: "doc_excerpt", locator: "README.md:1", summary: "login is supported" },
  { id: "route:1", kind: "route", locator: "src/auth.ts:10", summary: "POST /login" },
];

describe("anthropicModel request contract", () => {
  it("sends the documented request for proposeFeatures", async () => {
    const { client, calls } = fakeClient([fixture("propose.response.json")]);
    const model = anthropicModel({ model: "test-model", client });
    await model.proposeFeatures(bundle);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args;
    expect(req.model).toBe("test-model");
    expect(req.max_tokens).toBe(16000);
    expect(String(req.system)).toMatch(/Propose the project's user-facing features/);
    // biome-ignore lint/suspicious/noExplicitAny: output_config is a typed-helper field
    expect((req as any).output_config?.effort).toBe("high");
    expect(req.messages[0]?.role).toBe("user");
    expect(JSON.parse(String(req.messages[0]?.content))).toEqual({ evidence: bundle });
  });

  it("sends the DRAFT system prompt for draftReport", async () => {
    const { client, calls } = fakeClient([fixture("draft.response.json")]);
    const model = anthropicModel({ model: "test-model", client });
    await model.draftReport({
      bundle,
      features: [],
      checks: {},
      health: { score: 1, excluded: [] },
    });
    expect(String(calls[0]!.args.system)).toMatch(/You are writing a project report/);
  });
});

describe("anthropicModel response contract", () => {
  it("parses a recorded feature proposal and records usage", async () => {
    const { client } = fakeClient([fixture("propose.response.json")]);
    const model = anthropicModel({ model: "m", client });
    const { proposal, usage } = await model.proposeFeatures(bundle);
    expect(proposal.features.map((f) => f.name)).toEqual(["User login", "Password reset"]);
    expect(proposal.features[0]?.implementation_evidence_ids).toEqual(["route:1", "test:1"]);
    expect(usage).toEqual([
      { model: "claude-sonnet-4-5-20250929", inputTokens: 742, outputTokens: 118 },
    ]);
  });

  it("parses a recorded report draft into all five sections", async () => {
    const { client } = fakeClient([fixture("draft.response.json")]);
    const model = anthropicModel({ model: "m", client });
    const { draft, usage } = await model.draftReport({
      bundle,
      features: [],
      checks: {},
      health: { score: 1, excluded: [] },
    });
    expect(Object.keys(draft).sort()).toEqual([
      "features",
      "issues",
      "remaining",
      "summary",
      "value",
    ]);
    expect(draft.summary[0]?.evidence_ids).toEqual(["manifest:1"]);
    expect(usage[0]?.outputTokens).toBe(203);
  });

  it("raises ModelError with the category when the model refuses", async () => {
    const { client } = fakeClient([fixture("refusal.response.json")]);
    const model = anthropicModel({ model: "m", client });
    await expect(model.proposeFeatures(bundle)).rejects.toMatchObject({
      name: "ModelError",
      message: expect.stringMatching(/declined \(other\)/),
    });
  });

  it("repairs once when the first output is invalid, then succeeds", async () => {
    const invalid = {
      model: "m",
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: "text", text: "{}" }],
      parsed_output: { not: "a proposal" },
    };
    const { client, calls } = fakeClient([invalid, fixture("propose.response.json")]);
    const model = anthropicModel({ model: "m", client });
    const { proposal } = await model.proposeFeatures(bundle);
    expect(proposal.features).toHaveLength(2);
    expect(calls).toHaveLength(2);
    // The repair turn echoes the bad answer and nudges for valid JSON.
    expect(calls[1]!.args.messages).toHaveLength(3);
    expect(String(calls[1]!.args.messages.at(-1)?.content)).toMatch(/did not match the schema/);
  });

  it("asks for a shorter answer when the output was truncated, then succeeds", async () => {
    const truncated = {
      model: "m",
      stop_reason: "max_tokens",
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 16000 },
      content: [{ type: "text", text: '{"features":[' }],
      parsed_output: null,
    };
    const { client, calls } = fakeClient([truncated, fixture("propose.response.json")]);
    const model = anthropicModel({ model: "m", client });
    await model.proposeFeatures(bundle);
    expect(String(calls[1]!.args.messages.at(-1)?.content)).toMatch(/cut off/);
  });

  it("gives up with ModelError after the repair also fails", async () => {
    const bad = {
      model: "m",
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: "text", text: "{}" }],
      parsed_output: { wrong: true },
    };
    const { client, calls } = fakeClient([bad, bad]);
    const model = anthropicModel({ model: "m", client });
    await expect(model.proposeFeatures(bundle)).rejects.toBeInstanceOf(ModelError);
    expect(calls).toHaveLength(2);
  });
});
