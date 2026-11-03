#!/usr/bin/env node
// README walkthrough check (Section 3).
//
// The README's quickstart block is a promise: these commands work. This script keeps that
// promise honest so the documented happy path cannot rot silently.
//
//   1. Static validation — every command in the README's ```sh block still resolves:
//      each `pnpm <script>` is a real root script, each `node apps/cli/dist/main.js <sub>`
//      is a real CLI subcommand, each `docker build … <dir>` points at a real Dockerfile,
//      and every docs/ link in the README exists on disk.
//   2. Runnable happy path — the documented `pulse … --fix-prompt` invocation is executed
//      against a locally served fixture app and must report a verdict, proving the exact
//      command shape the README shows still produces the output it promises.
//
// Hermetic: no external network. The one executed command runs against the fixture harness
// on loopback (NODE_ENV=test + PULSE_TEST_ALLOW_HOSTS, the test-only SSRF allowance, ADR 0013).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

const failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => process.stdout.write(`  ok  ${msg}\n`);

// --- Extract the quickstart command block ----------------------------------------------
const block = /```sh\n([\s\S]*?)```/.exec(readme);
if (!block) {
  fail("README.md has no ```sh quickstart block");
} else {
  const commands = block[1]
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim()) // strip trailing comments
    .filter(Boolean);
  if (commands.length === 0) fail("the README quickstart block is empty");

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const cliHelp = runSync("node", ["apps/cli/dist/main.js", "--help"]);
  const cliSubcommands = new Set(
    [...cliHelp.stdout.matchAll(/^\s*codesentra\s+([a-z-]+)/gm)].map((m) => m[1]),
  );

  for (const cmd of commands) {
    // Each && segment is its own command.
    for (const seg of cmd.split("&&").map((s) => s.trim())) {
      const argv = seg.split(/\s+/);
      if (argv[0] === "pnpm") {
        const script = argv[1];
        // `pnpm install` is npm's own verb, not a package script.
        if (script === "install") ok(`pnpm install`);
        else if (scripts.has(script)) ok(`pnpm ${script} → package.json script exists`);
        else fail(`README runs \`pnpm ${script}\` but no such root script exists`);
      } else if (argv[0] === "node" && argv[1] === "apps/cli/dist/main.js") {
        const sub = argv[2];
        if (cliSubcommands.has(sub)) ok(`cli \`${sub}\` → documented subcommand exists`);
        else fail(`README runs CLI subcommand \`${sub}\` that the CLI does not list`);
      } else if (argv[0] === "docker" && argv[1] === "build") {
        const dir = argv[argv.length - 1];
        if (existsSync(join(root, dir, "Dockerfile")))
          ok(`docker build ${dir} → Dockerfile exists`);
        else fail(`README builds image from \`${dir}\` but ${dir}/Dockerfile is missing`);
      } else {
        ok(`(not executed, shape only) ${seg}`);
      }
    }
  }
}

// --- Validate the docs links the README points at --------------------------------------
for (const m of readme.matchAll(/\]\((docs\/[^)]+|\.env\.example)\)/g)) {
  const target = m[1].split("#")[0];
  if (existsSync(join(root, target))) ok(`link ${target} exists`);
  else fail(`README links ${target}, which does not exist`);
}

// --- Runnable happy path: pulse against a fixture app ----------------------------------
await runnablePulse().catch((e) => fail(`runnable pulse walkthrough failed: ${e.message}`));

// ---------------------------------------------------------------------------------------
if (failures.length > 0) {
  process.stderr.write(
    `\nREADME walkthrough FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write("\nREADME walkthrough OK\n");

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

async function runnablePulse() {
  const harness = spawn("node", ["fixtures/harness/dist/cli.js"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const targets = await readJson(harness);
    const url = targets.apps?.healthy?.url;
    if (!url) throw new Error("fixture harness did not expose a 'healthy' app");
    const pulse = await run("node", ["apps/cli/dist/main.js", "pulse", url, "--fix-prompt"], {
      env: { ...process.env, NODE_ENV: "test", PULSE_TEST_ALLOW_HOSTS: "127.0.0.1" },
    });
    if (![0, 1, 2].includes(pulse.status))
      throw new Error(`pulse exited ${pulse.status} (expected a verdict exit 0/1/2)`);
    if (!/Status:\s*(LIVE|DEGRADED|DOWN|UNVERIFIED)/i.test(pulse.stdout))
      throw new Error(`pulse output had no verdict line:\n${pulse.stdout}`);
    const verdict = /Status:\s*([A-Z]+)/i.exec(pulse.stdout)?.[1];
    if (verdict?.toUpperCase() !== "LIVE")
      throw new Error(`the healthy fixture should report LIVE, got ${verdict}`);
    ok(`pulse <fixture:healthy> --fix-prompt → Status: LIVE`);
  } finally {
    harness.kill("SIGTERM");
  }
}

function readJson(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = "";
    const timer = setTimeout(
      () => rejectPromise(new Error("harness did not print targets in time")),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      try {
        const parsed = JSON.parse(buf);
        clearTimeout(timer);
        resolvePromise(parsed);
      } catch {
        // keep buffering until the JSON document is complete
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`harness exited early (${code})`));
    });
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: root, encoding: "utf8", ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (status) => resolvePromise({ stdout, stderr, status }));
  });
}
