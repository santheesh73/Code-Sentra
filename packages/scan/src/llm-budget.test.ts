import type { Database } from "@codesentra/db";
import { describe, expect, it } from "vitest";
import { capModel, type ModelChoice, modelWithinBudget } from "./llm-budget.js";
import type { ReportModel } from "./model.js";

const fakeModel = { name: "test" } as unknown as ReportModel;
const configured: ModelChoice = { model: fakeModel };

describe("capModel", () => {
  it("passes the model through when the cap is disabled (0)", () => {
    expect(capModel(configured, { used: 9_999_999, cap: 0 })).toBe(configured);
  });

  it("passes the model through while under the cap", () => {
    expect(capModel(configured, { used: 100, cap: 1000 })).toBe(configured);
  });

  it("downgrades to a gap once used reaches the cap", () => {
    const r = capModel(configured, { used: 1000, cap: 1000 });
    expect(r.model).toBeNull();
    expect((r as { reason: string }).reason).toMatch(
      /monthly LLM token budget of 1,000 was reached/,
    );
    expect((r as { reason: string }).reason).toMatch(/1,000 used/);
  });

  it("downgrades once used exceeds the cap", () => {
    const r = capModel(configured, { used: 5000, cap: 1000 });
    expect(r.model).toBeNull();
  });

  it("keeps an already-unconfigured model's own reason while under budget", () => {
    const noKey: ModelChoice = { model: null, reason: "no ANTHROPIC_API_KEY" };
    expect(capModel(noKey, { used: 0, cap: 1000 })).toBe(noKey);
  });
});

describe("modelWithinBudget", () => {
  it("short-circuits without touching the database when the cap is disabled", async () => {
    const db = {
      withOrg() {
        throw new Error("should not query when cap is 0");
      },
    } as unknown as Database;
    expect(await modelWithinBudget(db, "org", configured, 0)).toBe(configured);
  });

  it("downgrades when the org's month-to-date tokens meet the cap", async () => {
    const db = {
      async withOrg<T>(_org: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
        // Stand in for orgTokensThisMonth: the tx.execute returns a summed total.
        const tx = {
          async execute() {
            return { rows: [{ total: "1500" }] };
          },
        };
        return fn(tx);
      },
    } as unknown as Database;
    const r = await modelWithinBudget(db, "org", configured, 1000);
    expect(r.model).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/1,500 used/);
  });
});
