import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectLanguage, isTestPath, parseFile, parserLanguageFor } from "./index.js";

const REPOS = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/repos");
const read = (repo: string, path: string) => readFileSync(join(REPOS, repo, "repo", path), "utf8");
const parse = async (repo: string, path: string) => {
  const f = await parseFile(path, read(repo, path));
  if (!f) throw new Error(`not parsed: ${path}`);
  return f;
};

describe("language detection", () => {
  it("maps extensions and shebangs", () => {
    expect(detectLanguage("src/a.tsx")).toBe("TypeScript");
    expect(detectLanguage("x/y.d.ts")).toBe("TypeScript");
    expect(detectLanguage("main.go")).toBe("Go");
    expect(detectLanguage("bin/tool", "#!/usr/bin/env python3")).toBe("Python");
    expect(detectLanguage("README")).toBeNull();
    expect(parserLanguageFor("a.jsx")).toBe("tsx");
    expect(parserLanguageFor("a.go")).toBeNull();
  });
  it("recognizes test paths", () => {
    for (const p of [
      "test/a.test.ts",
      "src/__tests__/x.ts",
      "tests/test_notes.py",
      "a.spec.js",
      "pkg/x_test.py",
    ])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ["src/latest.ts", "src/testing-utils.ts", "notes_api/app.py"])
      expect(isTestPath(p), p).toBe(false);
  });
});

describe("ts-taskboard (TypeScript, Express)", () => {
  it("finds every Express route at its registration line", async () => {
    const f = await parse("ts-taskboard", "src/routes/tasks.ts");
    expect(f.routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      "POST /tasks:8",
      "GET /tasks:17",
      "PATCH /tasks/:id/done:21",
      "GET /tasks/export.csv:30",
    ]);
    expect(f.imports.map((i) => i.specifier)).toEqual([
      "express",
      "../lib/csv.ts",
      "../lib/store.ts",
    ]);
    expect(f.symbols).toContainEqual({
      name: "tasksRouter",
      kind: "function",
      line: 5,
      exported: true,
    });
  });

  it("finds env reads", async () => {
    const f = await parse("ts-taskboard", "src/server.ts");
    expect(f.envReads.map((e) => `${e.name}:${e.line}`)).toEqual([
      "TASKBOARD_ADMIN_TOKEN:9",
      "PORT:22",
    ]);
    expect(f.envReads[0]?.text).toContain("process.env.TASKBOARD_ADMIN_TOKEN");
  });

  it("finds TODO markers in comments only", async () => {
    const f = await parse("ts-taskboard", "src/lib/store.ts");
    expect(f.markers).toEqual([
      { kind: "TODO", line: 32, text: "TODO: persist the completion timestamp" },
    ]);
    expect(f.stubs).toEqual([]);
  });

  it("finds the stub", async () => {
    const f = await parse("ts-taskboard", "src/lib/csv.ts");
    expect(f.stubs).toEqual([
      { symbol: "exportCsv", line: 4, text: 'throw new Error("not implemented");' },
    ]);
  });

  it("finds tests and the skipped one", async () => {
    const f = await parse("ts-taskboard", "test/store.test.ts");
    expect(f.tests.map((t) => `${t.name}:${t.line}:${t.skipped}`)).toEqual([
      "creates a task:6:false",
      "lists tasks newest first:13:false",
      "marks a task done:24:false",
      "exports tasks as CSV:30:true",
    ]);
    expect(f.tests[3]?.skipText).toContain('test.skip("exports tasks as CSV"');
  });
});

describe("py-notes-api (Python, FastAPI)", () => {
  it("finds FastAPI routes at the decorator line", async () => {
    const f = await parse("py-notes-api", "notes_api/app.py");
    expect(f.routes.map((r) => `${r.method} ${r.path}:${r.line}:${r.handler}`)).toEqual([
      "GET /:21:index",
      "POST /notes:26:create_note",
      "GET /notes:31:list_notes",
      "GET /notes/search:36:search_notes",
      "GET /notes/{note_id}/export.md:41:export_note",
    ]);
    expect(f.imports.filter((i) => i.kind === "python").map((i) => i.specifier)).toEqual([
      "fastapi",
      "fastapi.responses",
      "jinja2",
      "pydantic",
      "notes_api",
      "notes_api.export",
      "notes_api.store",
    ]);
    expect(f.imports.filter((i) => i.kind === "python-member").map((i) => i.specifier)).toContain(
      "notes_api.config",
    );
  });

  it("finds os.environ.get and os.getenv reads", async () => {
    const f = await parse("py-notes-api", "notes_api/config.py");
    expect(f.envReads.map((e) => `${e.name}:${e.line}`)).toEqual([
      "NOTES_DB_PATH:3",
      "NOTES_SIGNING_KEY:4",
    ]);
  });

  it("finds markers and stubs", async () => {
    expect((await parse("py-notes-api", "notes_api/store.py")).markers).toEqual([
      { kind: "TODO", line: 29, text: "TODO: search note bodies too" },
    ]);
    expect((await parse("py-notes-api", "notes_api/export.py")).stubs).toEqual([
      { symbol: "export_markdown", line: 5, text: "raise NotImplementedError" },
    ]);
  });

  it("finds pytest tests; a skip points at its decorator", async () => {
    const f = await parse("py-notes-api", "tests/test_notes.py");
    expect(f.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "test_create_note:16:false:null",
      "test_list_notes:22:false:null",
      "test_search_is_case_insensitive:28:false:null",
      "test_export_markdown:34:true:33",
    ]);
  });

  it("finds URL literals", async () => {
    const f = await parse("py-notes-api", "scripts/seed.py");
    expect(f.urlLiterals.map((u) => u.value)).toEqual(["http://127.0.0.1:8000/notes"]);
  });
});

describe("edge cases", () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the source under test is a template literal
  it("records env-interpolated URL templates for Link", async () => {
    const f = await parseFile(
      "app/page.tsx",
      "export default function Page() {\n  fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/ping`);\n  return <p>hi</p>;\n}\n",
    );
    expect(f?.urlLiterals).toEqual([
      {
        value: "${process.env.NEXT_PUBLIC_API_URL}/api/ping",
        line: 2,
        template: true,
        envVars: ["NEXT_PUBLIC_API_URL"],
      },
    ]);
    expect(f?.envReads.map((e) => e.name)).toEqual(["NEXT_PUBLIC_API_URL"]);
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above

  it("does not treat strings as markers or code", async () => {
    const f = await parseFile(
      "a.ts",
      'const s = "TODO: not a comment";\nconst u = "process.env.NOPE";\n',
    );
    expect(f?.markers).toEqual([]);
    expect(f?.envReads).toEqual([]);
  });

  it("only counts tests in test files", async () => {
    const f = await parseFile("src/util.ts", 'it("not a test", () => {});\n');
    expect(f?.tests).toEqual([]);
  });

  it("handles Fastify route objects, require, dynamic import and import.meta.env", async () => {
    const f = await parseFile(
      "server.js",
      'const x = require("./x");\napp.route({ method: "post", url: "/items" });\nconst y = await import("./y.js");\nconst k = import.meta.env.VITE_KEY;\nconst h = "http://localhost:4000/data";\n',
    );
    expect(f?.imports.map((i) => `${i.kind}:${i.specifier}`)).toEqual([
      "require:./x",
      "dynamic:./y.js",
    ]);
    expect(f?.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /items"]);
    expect(f?.envReads.map((e) => e.name)).toEqual(["VITE_KEY"]);
    expect(f?.urlLiterals.map((u) => u.value)).toEqual(["http://localhost:4000/data"]);
  });

  it("handles Flask route methods and os.environ[...]", async () => {
    const f = await parseFile(
      "app.py",
      'import os\n@app.route("/login", methods=["GET", "POST"])\ndef login():\n    return os.environ["SECRET"]\n',
    );
    expect(f?.routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      "GET /login:2",
      "POST /login:2",
    ]);
    expect(f?.envReads.map((e) => e.name)).toEqual(["SECRET"]);
  });

  it("counts syntax errors and still extracts what it can", async () => {
    const f = await parseFile("broken.ts", "const a = process.env.OK;\nfunction (\n");
    expect(f?.parseErrors).toBeGreaterThan(0);
    expect(f?.envReads.map((e) => e.name)).toEqual(["OK"]);
  });

  it("survives deeply nested input", async () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)};`;
    expect(await parseFile("deep.js", deep)).not.toBeNull();
  });

  it("returns null for languages without a parser", async () => {
    expect(await parseFile("main.go", "package main")).toBeNull();
  });
});
