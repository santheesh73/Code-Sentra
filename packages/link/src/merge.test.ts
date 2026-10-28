import { describe, expect, it } from "vitest";
import { mergeEnvFindings } from "./merge.js";

const pulse = [
  { key: "p1", envVars: ["NEXT_PUBLIC_API_URL"], sites: [{ path: "app/page.tsx", line: 9 }] },
];
const scan = (over: Partial<Parameters<typeof mergeEnvFindings>[1][number]> = {}) => ({
  key: "s1",
  code: "ENV_VAR_UNDOCUMENTED",
  envVar: "NEXT_PUBLIC_API_URL",
  path: "app/page.tsx",
  alreadyOpen: false,
  ...over,
});

describe("mergeEnvFindings", () => {
  it("folds the undocumented env var at the traced file into the Pulse issue", () => {
    expect(mergeEnvFindings(pulse, [scan()])).toEqual(new Map([["s1", "p1"]]));
  });

  it("keeps everything else separate", () => {
    for (const s of [
      scan({ envVar: "OTHER_VAR" }),
      scan({ path: "lib/api.ts" }),
      scan({ code: "TODO_MARKER" }),
      scan({ envVar: null }),
      // An open Scan issue keeps its own lifecycle; merging it away would resolve it falsely.
      scan({ alreadyOpen: true }),
    ])
      expect(mergeEnvFindings(pulse, [s]), JSON.stringify(s)).toEqual(new Map());
    expect(mergeEnvFindings([], [scan()])).toEqual(new Map());
  });
});
