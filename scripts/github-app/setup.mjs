#!/usr/bin/env node
// CodeSentra GitHub App setup CLI (Section 16). Three subcommands:
//
//   manifest --base-url https://app.example.com [--name "CodeSentra"] [--out <file>]
//       Print (or write) the GitHub App manifest and the exact create URL. Paste the manifest
//       into github.com/organizations/<org>/settings/apps/new (the page's "Create from
//       manifest" option) or settings/apps/new; GitHub then creates the App with the right
//       permissions, events and URLs and shows you the App id, private key, webhook secret and
//       client id/secret to put in your environment.
//
//   verify [--env-file <file>]
//       Check that a configured environment has every github_app var, well-formed, before you
//       start the API. Reads process.env, or KEY=VALUE lines from --env-file. Exit 1 on any
//       problem.
//
//   --self-test
//       Prove the generator and verifier against known-good and known-bad inputs. Used by the
//       commit that introduced this script; exit 1 on any failed assertion.
//
// Pure/offline: it prints what to do and validates config; it never calls GitHub or stores a
// secret. Completing the manifest flow and the conversion happen in your browser on github.com.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  buildManifest,
  REQUIRED_ENV,
  verifyAppEnv,
} from "./app-manifest.mjs";

function parseEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function cmdManifest(args) {
  const { values } = parseArgs({
    args,
    options: {
      "base-url": { type: "string" },
      name: { type: "string", default: "CodeSentra" },
      out: { type: "string" },
    },
  });
  if (!values["base-url"]) throw new Error("manifest requires --base-url https://app.example.com");
  const manifest = buildManifest({ name: values.name, baseUrl: values["base-url"] });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    process.stdout.write(`wrote ${values.out}\n`);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(
    "\nNext:\n" +
      "  1. Open https://github.com/settings/apps/new (personal) or\n" +
      "     https://github.com/organizations/<ORG>/settings/apps/new (org) and choose the\n" +
      '     manifest/"Create GitHub App from a manifest" flow, or POST this manifest to it.\n' +
      "  2. On the created App, generate a private key; copy the App id, client id, a new\n" +
      "     client secret and the webhook secret into your environment (see REQUIRED_ENV).\n" +
      `  3. Run: node scripts/github-app/setup.mjs verify --env-file <your .env>\n`,
  );
}

function cmdVerify(args) {
  const { values } = parseArgs({ args, options: { "env-file": { type: "string" } } });
  const env = values["env-file"] ? parseEnvFile(values["env-file"]) : process.env;
  const { ok, problems } = verifyAppEnv(env);
  if (ok) {
    process.stdout.write(`github_app environment OK (${REQUIRED_ENV.length} vars present)\n`);
    return;
  }
  process.stderr.write(
    `github_app environment INCOMPLETE:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
  );
  process.exitCode = 1;
}

function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-test failed: ${msg}`);
  };

  // Manifest: correct URLs derived from the base, least-privilege perms, exact events.
  const m = buildManifest({ baseUrl: "https://app.example.com" });
  assert(m.hook_attributes.url === "https://app.example.com/v1/webhooks/github", "webhook url");
  assert(m.setup_url === "https://app.example.com/v1/github/setup", "setup url");
  assert(m.public === false, "app must be private");
  assert(m.default_permissions.checks === "write", "checks:write");
  assert(m.default_permissions.contents === "read", "contents:read");
  assert(JSON.stringify(m.default_events) === JSON.stringify(APP_EVENTS), "events");
  assert(
    Object.keys(m.default_permissions).length === Object.keys(APP_PERMISSIONS).length,
    "perms",
  );

  // Base URL validation.
  let threw = false;
  try {
    buildManifest({ baseUrl: "ftp://nope" });
  } catch {
    threw = true;
  }
  assert(threw, "non-https base rejected");
  assert(
    buildManifest({ baseUrl: "http://localhost:3000" }).url === "http://localhost:3000",
    "localhost allowed",
  );

  // Verifier: a complete, well-formed env passes. The placeholder "secrets" are built from
  // repeated characters so no secret-shaped literal appears in source (keeps gitleaks quiet);
  // they only need to satisfy the length checks verifyAppEnv enforces.
  const pad = (prefix, n) => prefix + "x".repeat(n);
  const good = {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\\n${pad("", 8)}\\n-----END RSA PRIVATE KEY-----`,
    GITHUB_WEBHOOK_SECRET: pad("wh-", 16),
    GITHUB_APP_CLIENT_ID: "Iv1.placeholder",
    GITHUB_APP_CLIENT_SECRET: pad("cs-", 12),
    GITHUB_APP_SLUG: "codesentra",
  };
  assert(verifyAppEnv(good).ok, "good env should pass");

  // Verifier: each defect is caught.
  assert(!verifyAppEnv({ ...good, GITHUB_APP_ID: "abc" }).ok, "non-numeric id caught");
  assert(!verifyAppEnv({ ...good, GITHUB_APP_PRIVATE_KEY: "not a pem" }).ok, "bad pem caught");
  assert(
    !verifyAppEnv({ ...good, GITHUB_WEBHOOK_SECRET: "short" }).ok,
    "short webhook secret caught",
  );
  assert(
    !verifyAppEnv({ ...good, GITHUB_APP_CLIENT_SECRET: "x" }).ok,
    "short client secret caught",
  );
  assert(!verifyAppEnv({ ...good, GITHUB_APP_SLUG: "Bad Slug" }).ok, "bad slug caught");
  const missing = { ...good };
  delete missing.GITHUB_APP_ID;
  assert(!verifyAppEnv(missing).ok, "missing var caught");

  process.stdout.write("github-app setup self-test OK\n");
}

const [sub, ...rest] = process.argv.slice(2);
try {
  if (sub === "--self-test") selfTest();
  else if (sub === "manifest") cmdManifest(rest);
  else if (sub === "verify") cmdVerify(rest);
  else {
    process.stderr.write(
      "usage: setup.mjs <manifest --base-url URL | verify [--env-file F] | --self-test>\n",
    );
    process.exitCode = 2;
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
}
