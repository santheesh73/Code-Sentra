// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Parsed test run: counts and failing test names (as the runner printed them). */
export interface TestSummary {
  runner:
    | "node:test"
    | "pytest"
    | "vitest"
    | "jest"
    | "mocha"
    | "go"
    | "rspec"
    | "minitest"
    | "surefire"
    | "unknown";
  pass: number;
  fail: number;
  skip: number;
  failing: string[];
}

const num = (re: RegExp, s: string) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

/**
 * Reads pass/fail/skip counts from a test runner's output. Returns null when no known
 * summary is found, so an unparseable run is reported as unknown, never as passing.
 */
/**
 * `go test -json`: one event per line. Top-level tests are counted (subtests roll up into
 * their parent); a package that fails with no failing test (it did not build) counts as one
 * failure, so it is never read as passing.
 */
function parseGoTestJson(s: string): TestSummary | null {
  const final = new Map<string, string>();
  const pkgFailed = new Set<string>();
  const pkgWithFailures = new Set<string>();
  let events = 0;
  for (const line of s.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { Action?: string; Test?: string; Package?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.Action) continue;
    events++;
    if (!["pass", "fail", "skip"].includes(e.Action)) continue;
    if (!e.Test) {
      if (e.Action === "fail" && e.Package) pkgFailed.add(e.Package);
      continue;
    }
    if (e.Test.includes("/")) continue;
    final.set(`${e.Package}\u0000${e.Test}`, e.Action);
    if (e.Action === "fail" && e.Package) pkgWithFailures.add(e.Package);
  }
  if (!events) return null;
  const tally = (a: string) => [...final.values()].filter((v) => v === a).length;
  return {
    runner: "go",
    pass: tally("pass"),
    fail: tally("fail") + [...pkgFailed].filter((p) => !pkgWithFailures.has(p)).length,
    skip: tally("skip"),
    failing: [...final.entries()]
      .filter(([, v]) => v === "fail")
      .map(([k]) => k.split("\u0000")[1] as string),
  };
}

export function parseTestOutput(output: string): TestSummary | null {
  const s = stripAnsi(output);
  if (/^\{"Time":"[^"]+","Action":/m.test(s)) return parseGoTestJson(s);
  // node:test (TAP reporter, the default without a TTY): "# pass 2", "not ok 3 - name".
  if (/^# (tests|pass) \d+/m.test(s)) {
    return {
      runner: "node:test",
      pass: num(/^# pass (\d+)/m, s) ?? 0,
      fail: (num(/^# fail (\d+)/m, s) ?? 0) + (num(/^# cancelled (\d+)/m, s) ?? 0),
      skip: (num(/^# skipped (\d+)/m, s) ?? 0) + (num(/^# todo (\d+)/m, s) ?? 0),
      failing: [...s.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)]
        .map((m) => m[1] as string)
        .filter((n) => !/^\S+\.(test|spec)\.[cm]?[jt]s$/.test(n)),
    };
  }
  // node:test spec reporter: "ℹ pass 2".
  if (/^ℹ pass \d+/m.test(s)) {
    return {
      runner: "node:test",
      pass: num(/^ℹ pass (\d+)/m, s) ?? 0,
      fail: (num(/^ℹ fail (\d+)/m, s) ?? 0) + (num(/^ℹ cancelled (\d+)/m, s) ?? 0),
      skip: (num(/^ℹ skipped (\d+)/m, s) ?? 0) + (num(/^ℹ todo (\d+)/m, s) ?? 0),
      failing: [...s.matchAll(/^\s*✖ (.+?) \([\d.]+m?s\)\s*$/gm)].map((m) => m[1] as string),
    };
  }
  // pytest: "1 failed, 2 passed, 1 skipped in 0.31s"; "FAILED path::test - reason".
  const py =
    /^=*\s*((?:\d+ (?:failed|passed|skipped|xfailed|xpassed|errors?|deselected|warnings?)(?:, )?)+) in [\d.]+s/m.exec(
      s,
    );
  if (py) {
    const part = py[1] as string;
    const n = (k: string) => num(new RegExp(`(\\d+) ${k}`), part) ?? 0;
    return {
      runner: "pytest",
      pass: n("passed") + n("xpassed"),
      fail: n("failed") + n("errors?"),
      skip: n("skipped") + n("xfailed"),
      failing: [...s.matchAll(/^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/gm)].map((m) => m[1] as string),
    };
  }
  // vitest: "Tests  1 failed | 2 passed | 1 skipped (4)".
  const vt = /^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/m.exec(s);
  if (vt) {
    const part = vt[1] as string;
    return {
      runner: "vitest",
      pass: num(/(\d+) passed/, part) ?? 0,
      fail: num(/(\d+) failed/, part) ?? 0,
      skip: (num(/(\d+) skipped/, part) ?? 0) + (num(/(\d+) todo/, part) ?? 0),
      failing: [...s.matchAll(/^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?\s*$/gm)].map(
        (m) => m[1] as string,
      ),
    };
  }
  // jest: "Tests:       1 failed, 1 skipped, 2 passed, 4 total".
  const jt = /^Tests:\s+(.+?), (\d+) total/m.exec(s);
  if (jt) {
    const part = jt[1] as string;
    return {
      runner: "jest",
      pass: num(/(\d+) passed/, part) ?? 0,
      fail: num(/(\d+) failed/, part) ?? 0,
      skip: (num(/(\d+) skipped/, part) ?? 0) + (num(/(\d+) todo/, part) ?? 0),
      failing: [...s.matchAll(/^\s*● (.+?)\s*$/gm)].map(
        (m) => (m[1] as string).split(" › ").slice(-1)[0] as string,
      ),
    };
  }
  // RSpec: "3 examples, 1 failure, 1 pending"; failing examples as "rspec ./spec/x_spec.rb:21 # …"
  // (reported as `file:line`, which points at the example itself).
  const rs = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m.exec(s);
  if (rs) {
    const total = Number(rs[1]);
    const fail = Number(rs[2]);
    const skip = Number(rs[3] ?? 0);
    return {
      runner: "rspec",
      pass: total - fail - skip,
      fail,
      skip,
      failing: [...s.matchAll(/^rspec \.\/(\S+:\d+) #/gm)].map((m) => m[1] as string),
    };
  }
  // Minitest: "5 runs, 7 assertions, 1 failures, 0 errors, 1 skips"; "Class#test_x [file:line]".
  const mt = /^(\d+) runs, \d+ assertions, (\d+) failures, (\d+) errors, (\d+) skips/m.exec(s);
  if (mt) {
    const [runs, f, e, sk] = [mt[1], mt[2], mt[3], mt[4]].map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return {
      runner: "minitest",
      pass: runs - f - e - sk,
      fail: f + e,
      skip: sk,
      failing: [...s.matchAll(/^\S+#(test_\w+) \[/gm)].map((m) => m[1] as string),
    };
  }
  // mocha: "2 passing", "1 failing", "1 pending".
  if (/^\s*\d+ passing/m.test(s)) {
    return {
      runner: "mocha",
      pass: num(/^\s*(\d+) passing/m, s) ?? 0,
      fail: num(/^\s*(\d+) failing/m, s) ?? 0,
      skip: num(/^\s*(\d+) pending/m, s) ?? 0,
      failing: [...s.matchAll(/^\s+\d+\) (.+?):?\s*$/gm)].map((m) => m[1] as string),
    };
  }
  return null;
}

export interface ErrorLine {
  file: string;
  line: number;
  message: string;
}

/**
 * First `max` diagnostics with a file and line from compiler, linter or traceback output.
 * Paths outside the project (node_modules, absolute system paths) are skipped.
 */
export function parseErrorLines(output: string, max = 20): ErrorLine[] {
  const s = stripAnsi(output);
  const out: ErrorLine[] = [];
  const push = (file: string, line: string, message: string) => {
    const f = file.replace(/^\.\//, "").replace(/^\/work\//, "");
    if (
      f.startsWith("/") ||
      f.includes("node_modules/") ||
      f.includes(".cs-venv/") ||
      f.startsWith(".cs-gomod/")
    )
      return;
    if (
      out.length < max &&
      !out.some((e) => e.file === f && e.line === Number(line) && e.message === message)
    )
      out.push({ file: f, line: Number(line), message: message.trim().slice(0, 300) });
  };
  for (const m of s.matchAll(/^(\S+?\.[cm]?[jt]sx?)\((\d+),\d+\): (error .+)$/gm))
    push(m[1] as string, m[2] as string, m[3] as string);
  for (const m of s.matchAll(/^(\S+?\.[a-z]{1,5}):(\d+):\d+ - (error .+)$/gm))
    push(m[1] as string, m[2] as string, m[3] as string);
  for (const m of s.matchAll(/^(\S+?\.py):(\d+):(?:\d+:)? (.+)$/gm))
    push(m[1] as string, m[2] as string, m[3] as string);
  // Go compiler and vet: "./cart.go:12:5: undefined: x" (vet may prefix "vet: ").
  for (const m of s.matchAll(/^(?:vet: )?(\S+?\.go):(\d+):(?:\d+:)? (.+)$/gm))
    push(m[1] as string, m[2] as string, m[3] as string);
  for (const m of s.matchAll(/File "([^"]+\.py)", line (\d+)/g))
    push(m[1] as string, m[2] as string, "traceback");
  // eslint stylish: path on its own line, then "  3:5  error  message  rule".
  let current: string | null = null;
  for (const line of s.split("\n")) {
    if (/^\S.*\.[cm]?[jt]sx?$/.test(line)) current = line.trim();
    const m = /^\s+(\d+):\d+\s+error\s+(.+)$/.exec(line);
    if (m && current) push(current, m[1] as string, m[2] as string);
  }
  return out;
}
