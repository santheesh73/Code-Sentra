import { loadFixtureRepos, type RepoExpectation } from "./repos.js";

/**
 * TEST ONLY. A scripted stand-in for the report model, for the fixture repos only.
 *
 * It does what a correct model would do with the evidence bundle, using each fixture's
 * expected.json as its answer key: proposes the documented features and cites the
 * evidence at the expected locators (it never supplies a status, which the classifier
 * computes), and drafts a report that includes true claims *and* every forbidden claim
 * from expected.json, each citing the broadest evidence possible, so the gate proves the
 * verifier drops them. It refuses any project that is not a fixture repo, and
 * packages/config only allows it when NODE_ENV=test (ADR 0017).
 */
interface BundleItem {
  id: string;
  kind: string;
  locator: string;
  summary: string;
}

export const FIXTURE_MODEL_NAME = "codesentra-fixture-model (test only)";

function fixtureOf(bundle: BundleItem[]): RepoExpectation {
  const names = new Set(
    bundle
      .filter((b) => b.kind === "manifest")
      .flatMap((b) => [...b.summary.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1] as string)),
  );
  const repo = loadFixtureRepos().find((r) => names.has(r.expected.name));
  if (!repo) throw new Error("the fixture model only knows the fixture repos");
  return repo.expected;
}

const fileOf = (locator: string) => locator.split(/[:#]/)[0] as string;

export function fixtureReportModel() {
  return {
    name: FIXTURE_MODEL_NAME,
    async proposeFeatures(bundle: BundleItem[]) {
      const exp = fixtureOf(bundle);
      const at = (locator: string, kinds: string[]) =>
        bundle.find((b) => kinds.includes(b.kind) && b.locator === locator) ??
        // A method inside a file: cite the file-level fact.
        bundle.find((b) => b.kind === "code_fact" && b.locator === fileOf(locator));
      const features = exp.features.map((f) => {
        const impl = (f.implementation ?? [])
          .map((l) => at(l, ["route", "code_fact"])?.id)
          .filter((x): x is string => !!x);
        const tests = (f.tests ?? [])
          .map((l) => at(l, ["test_result"])?.id)
          .filter((x): x is string => !!x);
        const route = bundle.find((b) => b.id === impl[0] && b.kind === "route");
        const path = route ? /"path":"([^"]+)"/.exec(route.summary)?.[1] : undefined;
        const intent = [
          ...(f.intent ?? []).map((l) => at(l, ["doc_excerpt"])?.id),
          path
            ? bundle.find((b) => b.kind === "doc_excerpt" && b.summary.includes(path))?.id
            : undefined,
        ].filter((x): x is string => !!x);
        return {
          name: f.name,
          intent_evidence_ids: [...new Set(intent)],
          implementation_evidence_ids: [...impl, ...tests],
        };
      });
      return { proposal: { features }, usage: [] };
    },
    async draftReport(input: {
      bundle: BundleItem[];
      features: { name: string; status: string; reason: string; evidence_ids: string[] }[];
      checks: Record<string, string>;
    }) {
      const exp = fixtureOf(input.bundle);
      const b = input.bundle;
      const first = (kind: string, pred: (x: BundleItem) => boolean = () => true) =>
        b.find((x) => x.kind === kind && pred(x))?.id;
      const manifest = first("manifest", (x) => x.summary.includes('"description"'));
      const ids = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x);
      const everything = b
        .filter(
          (x) =>
            x.kind !== "doc_excerpt" ||
            x.summary.includes("Features") ||
            x.summary.includes("Roadmap"),
        )
        .map((x) => x.id);
      const envRead = exp.envVars.read[0];
      const envEv = envRead
        ? first("env_var_read", (x) => x.locator === envRead.locator)
        : undefined;
      const tests = first("probe_result", (x) => x.locator.endsWith("#tests"));
      const t = exp.probes.tests;
      const claim = (text: string, evidence_ids: string[]) => ({ text, evidence_ids });
      return {
        draft: {
          summary: [
            claim(
              `${exp.name} is ${/"description":"([^"]+)"/.exec(b.find((x) => x.id === manifest)?.summary ?? "")?.[1] ?? "a project"}.`,
              ids(manifest),
            ),
          ],
          value: [
            claim(
              `It is built with ${exp.frameworks[0]}.`,
              ids(first("manifest", (x) => x.summary.includes("frameworks"))),
            ),
          ],
          features: input.features.map((f) => claim(`${f.name} is ${f.status}.`, f.evidence_ids)),
          issues: [
            ...(envRead && envEv
              ? [claim(`${envRead.name} is read in ${fileOf(envRead.locator)}.`, ids(envEv))]
              : []),
            claim(
              `${t.pass} of ${t.pass + t.fail + t.skip} tests pass and ${t.fail} fails.`,
              ids(tests),
            ),
            // Every forbidden claim, citing as much as possible: the verifier must drop all.
            ...exp.forbiddenClaims.map((c) => claim(c.text, everything)),
          ],
          remaining: [],
        },
        usage: [],
      };
    },
  };
}
