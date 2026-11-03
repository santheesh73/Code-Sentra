import { defineConfig } from "vitest/config";

// Coverage floors are a regression ratchet set just under the current measured values
// (not a fabricated target). Raising them is welcome; dropping below fails CI (Section 3).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 90, branches: 85, functions: 92, lines: 90 },
    },
  },
});
