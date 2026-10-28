// Builds dist/npm/: the whole CLI in one file (grammars embedded) plus the manifest npm
// publishes. Publishing is a human step (docs/runbook.md); this only builds the folder.
// Only playwright-core stays external (it ships browsers' protocol code and is optional:
// Pulse needs it, Scan does not), so `npm i -g @codesentra/cli` installs one dependency.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const parsers = createRequire(new URL("../../../packages/parsers/package.json", import.meta.url));
const wasm = {
  runtime: "web-tree-sitter/web-tree-sitter.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const b64 = (spec) => readFileSync(parsers.resolve(spec)).toString("base64");

const entry = `
import { useEmbeddedWasm } from "@codesentra/parsers";
const bytes = (s) => Uint8Array.from(Buffer.from(s, "base64"));
useEmbeddedWasm({
  runtime: bytes(${JSON.stringify(b64(wasm.runtime))}),
  languages: {
    typescript: bytes(${JSON.stringify(b64(wasm.typescript))}),
    tsx: bytes(${JSON.stringify(b64(wasm.tsx))}),
    javascript: bytes(${JSON.stringify(b64(wasm.javascript))}),
    python: bytes(${JSON.stringify(b64(wasm.python))}),
  },
});
await import("./dist/main.js");
`;

await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "bundle-entry.mjs", loader: "js" },
  outfile: `${root}dist/npm/codesentra.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["playwright-core", "pg-native"],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire as __csRequire } from "node:module"; const require = __csRequire(import.meta.url);`,
  },
  legalComments: "eof",
  logLevel: "info",
});

// The published manifest names no workspace packages: they are all inside the bundle.
mkdirSync(`${root}dist/npm`, { recursive: true });
writeFileSync(
  `${root}dist/npm/package.json`,
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      // No license is chosen for the repository yet; set one before publishing.
      license: "UNLICENSED",
      type: "module",
      bin: { codesentra: "./codesentra.mjs" },
      files: ["codesentra.mjs"],
      engines: { node: ">=22" },
      dependencies: { "playwright-core": pkg.dependencies["playwright-core"] },
    },
    null,
    2,
  )}\n`,
);
