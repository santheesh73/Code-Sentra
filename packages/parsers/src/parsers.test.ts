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
    expect(parserLanguageFor("a.go")).toBe("go");
    expect(parserLanguageFor("app/models/note.rb")).toBe("ruby");
    expect(parserLanguageFor("Gemfile")).toBe("ruby");
    expect(detectLanguage("Rakefile")).toBe("Ruby");
    expect(parserLanguageFor("src/main/java/A.java")).toBe("java");
    expect(parserLanguageFor("src/main.rs")).toBe("rust");
    expect(parserLanguageFor("src/Store.php")).toBe("php");
    expect(parserLanguageFor("bin/console", "#!/usr/bin/env php")).toBe("php");
    expect(parserLanguageFor("a.swift")).toBeNull();
  });
  it("recognizes test paths", () => {
    for (const p of [
      "test/a.test.ts",
      "src/__tests__/x.ts",
      "tests/test_notes.py",
      "a.spec.js",
      "pkg/x_test.py",
      "internal/cart/cart_test.go",
      "spec/models/note_spec.rb",
      "test/store_test.rb",
      "src/test/java/com/x/CartTest.java",
      "tests/store.rs",
      "tests/Unit/StoreTest.php",
    ])
      expect(isTestPath(p), p).toBe(true);
    for (const p of [
      "src/latest.ts",
      "src/testing-utils.ts",
      "notes_api/app.py",
      "internal/cart/cart.go",
      "src/main/java/com/x/Contest.java",
      "src/store.rs",
      "src/Latest.php",
    ])
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

const APPS = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/apps");
const app = async (name: string) => {
  const f = await parseFile("app/page.tsx", readFileSync(join(APPS, name, "app/page.tsx"), "utf8"));
  if (!f) throw new Error(`not parsed: ${name}`);
  return f;
};

describe("code facts Sentra Link joins on (fixture apps)", () => {
  it("env-undefined: the URL template, its env var and the line", async () => {
    const f = await app("env-undefined");
    expect(f.urlLiterals).toContainEqual(
      expect.objectContaining({ line: 9, template: true, envVars: ["NEXT_PUBLIC_API_URL"] }),
    );
    expect(f.urlLiterals.find((u) => u.line === 9)?.text).toContain(
      "process.env.NEXT_PUBLIC_API_URL}/api/ping",
    );
  });

  it("localhost-leak: the URL literal with host and port", async () => {
    const f = await app("localhost-leak");
    expect(f.urlLiterals).toContainEqual(
      expect.objectContaining({ value: "http://localhost:4000/data", line: 9 }),
    );
  });

  it("broken-route: every href with its line", async () => {
    const f = await app("broken-route");
    expect(f.hrefs.map((h) => `${h.value}@${h.line}`)).toEqual(["/about@7", "/pricing@7"]);
  });

  it("console-throw: the thrown message", async () => {
    const f = await app("console-throw");
    expect(f.messages).toEqual([
      {
        value: "CS_FIXTURE_BOOM",
        line: 9,
        text: 'throw new Error("CS_FIXTURE_BOOM");',
        kind: "throw",
      },
    ]);
  });

  it("blank: the default export (the page component)", async () => {
    const f = await app("blank");
    expect(f.defaultExport).toEqual({
      name: "Home",
      line: 1,
      text: "export default function Home() {",
    });
  });

  it("records constructed errors, console.error and Python raise messages", async () => {
    const js = await parseFile(
      "src/a.ts",
      'const e = new TypeError("bad input");\nconsole.error("save failed");\n',
    );
    expect(js?.messages.map((m) => `${m.kind}:${m.value}`)).toEqual([
      "error:bad input",
      "console:save failed",
    ]);
    const py = await parseFile("a.py", 'def f():\n    raise ValueError("no such note")\n');
    expect(py?.messages.map((m) => `${m.kind}:${m.value}@${m.line}`)).toEqual([
      "throw:no such note@2",
    ]);
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
        text: "fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/ping`);",
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
    expect(await parseFile("main.swift", "func main() {}")).toBeNull();
  });
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const at = (xs: { line: number }[], f: (x: never) => string) =>
  xs.map((x) => `${f(x as never)}:${x.line}`);

describe("Go", () => {
  const src = lines(
    "package main", //                                            1
    "",
    "import (",
    '\t"errors"',
    '\t"net/http"',
    '\t"os"',
    '\tapi "example.com/shop/internal/api"',
    ")",
    "",
    "// TODO: wire the cache", //                                 10
    "func Handler(w http.ResponseWriter, r *http.Request) {}",
    "",
    "func Export() error {",
    '\tpanic("not implemented")',
    "}",
    "",
    "func main() {",
    '\tbase := os.Getenv("API_URL")',
    '\t_, _ = os.LookupEnv("PORT")',
    '\thttp.HandleFunc("/health", Handler)', //                   20
    '\tmux.HandleFunc("GET /items/{id}", api.Item)',
    '\tr.POST("/users", createUser)',
    '\tr.Get("/users/:id", getUser)',
    '\t_ = os.Getenv("API_URL") + "/api/ping"',
    '\t_ = fmt.Sprintf("%s/v1/items", os.Getenv("API_URL"))',
    '\t_ = "http://localhost:4000/data"',
    '\t_ = errors.New("cart is empty")',
    "\t_ = base",
    "}",
  );

  it("extracts imports, symbols, routes, env reads, URLs, messages, markers and stubs", async () => {
    const f = await parseFile("cmd/shop/main.go", src);
    if (!f) throw new Error("not parsed");
    expect(f.parseErrors).toBe(0);
    expect(f.imports.map((i) => `${i.kind} ${i.specifier}`)).toEqual([
      "go errors",
      "go net/http",
      "go os",
      "go example.com/shop/internal/api",
    ]);
    expect(f.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual([
      "Handler:true",
      "Export:true",
      "main:false",
    ]);
    expect(
      at(
        f.routes,
        (r: { method: string; path: string; handler: string }) =>
          `${r.method} ${r.path} ${r.handler}`,
      ),
    ).toEqual([
      "GET /health Handler:20",
      "GET /items/{id} Item:21",
      "POST /users createUser:22",
      "GET /users/:id getUser:23",
    ]);
    expect(at(f.envReads, (e: { name: string }) => e.name)).toEqual([
      "API_URL:18",
      "PORT:19",
      "API_URL:24",
      "API_URL:25",
    ]);
    expect(f.urlLiterals.map((u) => `${u.template} ${u.value} [${u.envVars}]`)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${os.Getenv("API_URL")}/api/ping [API_URL]',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${os.Getenv("API_URL")}/v1/items [API_URL]',
      "false http://localhost:4000/data []",
    ]);
    expect(at(f.messages, (m: { kind: string; value: string }) => `${m.kind} ${m.value}`)).toEqual([
      "throw not implemented:14",
      "error cart is empty:27",
    ]);
    expect(at(f.markers, (m: { kind: string }) => m.kind)).toEqual(["TODO:10"]);
    expect(at(f.stubs, (s: { symbol: string }) => s.symbol)).toEqual(["Export:14"]);
  });

  it("finds Test functions and t.Skip in _test.go files", async () => {
    const f = await parseFile(
      "internal/cart/cart_test.go",
      lines(
        "package cart",
        'import "testing"',
        "func TestAdd(t *testing.T) {}",
        "func TestExport(t *testing.T) {",
        '\tt.Skip("later")',
        "}",
        "func helper() {}",
      ),
    );
    expect(f?.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "TestAdd:3:false:null",
      "TestExport:4:true:5",
    ]);
  });
});

describe("Ruby", () => {
  it("extracts Sinatra routes, ENV reads, requires, raises and stubs", async () => {
    const f = await parseFile(
      "app.rb",
      lines(
        'require "sinatra/base"', //                                1
        'require_relative "lib/store"',
        "",
        "# FIXME: cache this",
        "class NotesApp < Sinatra::Base",
        '  get "/notes/:id" do',
        '    ENV["NOTES_KEY"]',
        "  end",
        '  post "/notes" do',
        "  end", //                                                  10
        "  def export",
        "    raise NotImplementedError",
        "  end",
        "  def boom",
        '    raise ArgumentError, "note is empty"',
        "  end",
        "  def api",
        '    ENV.fetch("API_URL") + "/api/ping"',
        "  end",
        "end", //                                                    20
        'LEAK = "http://localhost:4000/data"',
        'U = "#{ENV["API_URL"]}/v1/notes"',
      ),
    );
    if (!f) throw new Error("not parsed");
    expect(f.parseErrors).toBe(0);
    expect(f.imports.map((i) => `${i.kind} ${i.specifier}`)).toEqual([
      "ruby sinatra/base",
      "ruby-relative lib/store",
    ]);
    expect(f.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual([
      "class NotesApp",
      "function export",
      "function boom",
      "function api",
    ]);
    expect(at(f.routes, (r: { method: string; path: string }) => `${r.method} ${r.path}`)).toEqual([
      "GET /notes/:id:6",
      "POST /notes:9",
    ]);
    expect(at(f.envReads, (e: { name: string }) => e.name)).toEqual([
      "NOTES_KEY:7",
      "API_URL:18",
      "API_URL:22",
    ]);
    expect(f.urlLiterals.map((u) => `${u.template} ${u.value} [${u.envVars}]`)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${ENV.fetch("API_URL")}/api/ping [API_URL]',
      "false http://localhost:4000/data []",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${ENV["API_URL"]}/v1/notes [API_URL]',
    ]);
    expect(at(f.messages, (m: { value: string }) => m.value)).toEqual(["note is empty:15"]);
    expect(at(f.markers, (m: { kind: string }) => m.kind)).toEqual(["FIXME:4"]);
    expect(at(f.stubs, (s: { symbol: string }) => s.symbol)).toEqual(["export:12"]);
  });

  it("reads Rails routes with namespaces and root", async () => {
    const f = await parseFile(
      "config/routes.rb",
      lines(
        "Rails.application.routes.draw do",
        '  root "home#index"',
        '  get "up", to: "health#show"',
        "  namespace :api do",
        '    post "users/sign_in", to: "sessions#create"',
        "  end",
        "end",
      ),
    );
    expect(f?.routes.map((r) => `${r.method} ${r.path} ${r.handler}:${r.line}`)).toEqual([
      "GET / home#index:2",
      "GET /up health#show:3",
      "POST /api/users/sign_in sessions#create:5",
    ]);
  });

  it("finds RSpec and Minitest cases and their skips", async () => {
    const spec = await parseFile(
      "spec/store_spec.rb",
      lines(
        "RSpec.describe Store do",
        '  it "adds a note" do',
        "  end",
        '  xit "exports" do',
        "  end",
        '  it "searches", skip: true do',
        "  end",
        '  it "pends" do',
        '    pending "later"',
        "  end",
        "end",
      ),
    );
    expect(spec?.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "adds a note:2:false:null",
      "exports:4:true:4",
      "searches:6:true:6",
      "pends:8:true:9",
    ]);
    const mini = await parseFile(
      "test/store_test.rb",
      lines("class StoreTest < Minitest::Test", "  def test_add", "    skip", "  end", "end"),
    );
    expect(mini?.tests.map((t) => `${t.name}:${t.skipped}:${t.skipLine}`)).toEqual([
      "test_add:true:3",
    ]);
  });
});

describe("Java", () => {
  it("extracts Spring routes with the class prefix, env reads, throws and stubs", async () => {
    const f = await parseFile(
      "src/main/java/com/example/shop/ItemController.java",
      lines(
        "package com.example.shop;", //                              1
        "",
        "import java.util.List;",
        "import com.example.shop.model.*;",
        "import static com.example.shop.Util.slug;",
        "",
        "// TODO: paginate",
        "@RestController",
        '@RequestMapping("/api")',
        "public class ItemController {", //                          10
        '  private static final String BASE = System.getenv("API_URL");',
        '  @GetMapping("/items/{id}")',
        "  public Item get(@PathVariable String id) { return null; }",
        '  @PostMapping(value = "/items")',
        '  public Item create() { throw new UnsupportedOperationException("Not implemented yet"); }',
        '  @RequestMapping(path = "/legacy", method = RequestMethod.DELETE)',
        '  void legacy() { throw new IllegalStateException("cart is empty"); }',
        '  String url() { return System.getenv("API_URL") + "/api/ping"; }',
        '  String loc = "http://localhost:4000/data";',
        "}", //                                                      20
      ),
    );
    if (!f) throw new Error("not parsed");
    expect(f.parseErrors).toBe(0);
    expect(f.imports.map((i) => `${i.kind} ${i.specifier}`)).toEqual([
      "java java.util.List",
      "java-wildcard com.example.shop.model",
      "java com.example.shop.Util",
    ]);
    expect(f.symbols.map((s) => `${s.kind} ${s.name}:${s.exported}`)).toEqual([
      "class ItemController:true",
      "function get:true",
      "function create:true",
      "function legacy:false",
      "function url:false",
    ]);
    expect(
      at(
        f.routes,
        (r: { method: string; path: string; handler: string }) =>
          `${r.method} ${r.path} ${r.handler}`,
      ),
    ).toEqual([
      "GET /api/items/{id} get:12",
      "POST /api/items create:14",
      "DELETE /api/legacy legacy:16",
    ]);
    expect(at(f.envReads, (e: { name: string }) => e.name)).toEqual(["API_URL:11", "API_URL:18"]);
    expect(f.urlLiterals.map((u) => `${u.template} ${u.value} [${u.envVars}]`)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${System.getenv("API_URL")}/api/ping [API_URL]',
      "false http://localhost:4000/data []",
    ]);
    expect(at(f.messages, (m: { kind: string; value: string }) => `${m.kind} ${m.value}`)).toEqual([
      "throw Not implemented yet:15",
      "throw cart is empty:17",
    ]);
    expect(at(f.markers, (m: { kind: string }) => m.kind)).toEqual(["TODO:7"]);
    expect(at(f.stubs, (s: { symbol: string }) => s.symbol)).toEqual(["create:15"]);
  });

  it("reads JAX-RS routes and JUnit tests with @Disabled", async () => {
    const res = await parseFile(
      "src/main/java/a/Notes.java",
      lines(
        '@Path("/notes")',
        "public class Notes {",
        "  @GET",
        '  @Path("/{id}")',
        "  public String one() { return null; }",
        "  @POST",
        "  public void add() {}",
        "}",
      ),
    );
    expect(res?.routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      "GET /notes/{id}:3",
      "POST /notes:6",
    ]);
    const t = await parseFile(
      "src/test/java/a/NotesTest.java",
      lines(
        "class NotesTest {",
        "  @Test",
        "  void adds() {}",
        '  @Disabled("flaky")',
        "  @Test",
        "  void exports() {}",
        "}",
      ),
    );
    expect(t?.tests.map((x) => `${x.name}:${x.line}:${x.skipped}:${x.skipLine}`)).toEqual([
      "adds:3:false:null",
      "exports:6:true:4",
    ]);
  });
});

describe("Rust", () => {
  const src = lines(
    "mod store;", //                                               1
    "pub mod api;",
    "use crate::store::{Store, Note as N};",
    "use axum::{routing::get, Router};",
    "use std::env;",
    "",
    "// TODO: add auth", //                                        7
    "pub fn app() -> Router {",
    '    let base = std::env::var("API_URL").unwrap();',
    "    Router::new()", //                                        10
    '        .route("/notes", get(list).post(create))',
    '        .nest("/api", Router::new().route("/items/:id", axum::routing::delete(remove)))',
    "}",
    "",
    "pub fn export() -> String {",
    "    todo!()",
    "}",
    "",
    "fn urls() {",
    '    let a = format!("{}/api/ping", env::var("API_URL").unwrap());', // 20
    '    let b = env::var("API_URL").unwrap() + "/v1/items";',
    '    let c = "http://localhost:4000/data";',
    '    panic!("store is closed");',
    '    let d = anyhow!("note not found");',
    '    eprintln!("bad input {}", a);',
    "}",
    "",
    '#[get("/health")]',
    'async fn health() -> &\'static str { "ok" }',
    "struct Hidden;", //                                           30
    "pub const PORT: u16 = 3000;",
  );

  it("extracts imports, symbols, routes, env reads, URLs, messages, markers and stubs", async () => {
    const f = await parseFile("src/lib.rs", src);
    if (!f) throw new Error("not parsed");
    expect(f.parseErrors).toBe(0);
    expect(f.imports.map((i) => `${i.kind} ${i.specifier}`)).toEqual([
      "rust-mod store",
      "rust-mod api",
      "rust crate::store::Store",
      "rust crate::store::Note",
      "rust axum::routing::get",
      "rust axum::Router",
      "rust std::env",
    ]);
    expect(f.symbols.map((s) => `${s.name}:${s.kind}:${s.exported}`)).toEqual([
      "app:function:true",
      "export:function:true",
      "urls:function:false",
      "health:function:false",
      "Hidden:class:false",
      "PORT:variable:true",
    ]);
    expect(
      at(
        f.routes,
        (r: { method: string; path: string; handler: string }) =>
          `${r.method} ${r.path} ${r.handler}`,
      ),
    ).toEqual([
      "GET /notes list:11",
      "POST /notes create:11",
      "DELETE /api/items/:id remove:12",
      "GET /health health:28",
    ]);
    expect(at(f.envReads, (e: { name: string }) => e.name)).toEqual([
      "API_URL:9",
      "API_URL:20",
      "API_URL:21",
    ]);
    expect(f.urlLiterals.map((u) => `${u.template} ${u.value} [${u.envVars}]`)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${env::var("API_URL")}/api/ping [API_URL]',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      'true ${env::var("API_URL")}/v1/items [API_URL]',
      "false http://localhost:4000/data []",
    ]);
    expect(at(f.messages, (m: { kind: string; value: string }) => `${m.kind} ${m.value}`)).toEqual([
      "throw store is closed:23",
      "error note not found:24",
      "console bad input {}:25",
    ]);
    expect(at(f.markers, (m: { kind: string }) => m.kind)).toEqual(["TODO:7"]);
    expect(at(f.stubs, (s: { symbol: string }) => s.symbol)).toEqual(["export:16"]);
  });

  it("finds #[test] functions anywhere and #[ignore] skips", async () => {
    const f = await parseFile(
      "src/store.rs",
      lines(
        "pub fn add() {}",
        "#[cfg(test)]",
        "mod tests {",
        "    #[test]",
        "    fn adds() {}",
        "    #[tokio::test]",
        '    #[ignore = "export is not built yet"]',
        "    async fn exports() {}",
        "    fn helper() {}",
        "}",
      ),
    );
    expect(f?.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "adds:5:false:null",
      "exports:8:true:7",
    ]);
    expect(f?.symbols.map((s) => s.name)).toEqual(["add"]);
  });
});

describe("PHP", () => {
  const src = lines(
    "<?php", //                                                    1
    "namespace App;",
    "",
    "use App\\Store\\{Notes, Tags as T};",
    "use Psr\\Http\\Message\\ResponseInterface;",
    "use function App\\helper;",
    "require __DIR__ . '/../vendor/autoload.php';",
    "",
    "// TODO: rate limiting",
    "$app->get('/health', function ($req, $res) { return $res; });", // 10
    "$app->group('/api', function ($group) {",
    "    $group->post('/notes', [NotesController::class, 'create']);",
    "    $group->map(['PUT', 'PATCH'], '/notes/{id}', 'NotesController:update');",
    "});",
    "Route::prefix('admin')->group(function () {",
    "    Route::delete('users/{id}', [UserController::class, 'destroy']);",
    "});",
    "$base = getenv('API_URL');",
    "$key = $_ENV['API_KEY'] ?? env('APP_KEY');",
    "$u = getenv('API_URL') . '/api/ping';", //                     20
    "$v = sprintf('%s/v1/items', getenv('API_URL'));",
    "$w = 'http://localhost:4000/data';",
    "error_log('cache miss');",
    "",
    "#[Route('/reports')]",
    "final class ReportController",
    "{",
    "    #[Route('/{id}', methods: ['GET'])]",
    "    public function show(): string",
    "    {", //                                                      30
    "        throw new \\RuntimeException('report not found');",
    "    }",
    "",
    "    private function export(): string",
    "    {",
    "        throw new \\LogicException('Not implemented yet');",
    "    }",
    "}",
  );

  it("extracts imports, symbols, routes, env reads, URLs, messages, markers and stubs", async () => {
    const f = await parseFile("src/routes.php", src);
    if (!f) throw new Error("not parsed");
    expect(f.parseErrors).toBe(0);
    expect(f.imports.map((i) => `${i.kind} ${i.specifier}`)).toEqual([
      "php App\\Store\\Notes",
      "php App\\Store\\Tags",
      "php Psr\\Http\\Message\\ResponseInterface",
      "php-require ../vendor/autoload.php",
    ]);
    expect(f.symbols.map((s) => `${s.name}:${s.kind}:${s.exported}`)).toEqual([
      "ReportController:class:true",
      "show:function:true",
      "export:function:false",
    ]);
    expect(
      at(
        f.routes,
        (r: { method: string; path: string; handler: string }) =>
          `${r.method} ${r.path} ${r.handler}`,
      ),
    ).toEqual([
      "GET /health null:10",
      "POST /api/notes create:12",
      "PUT /api/notes/{id} update:13",
      "PATCH /api/notes/{id} update:13",
      "DELETE /admin/users/{id} destroy:16",
      "GET /reports/{id} show:28",
    ]);
    expect(at(f.envReads, (e: { name: string }) => e.name)).toEqual([
      "API_URL:18",
      "API_KEY:19",
      "APP_KEY:19",
      "API_URL:20",
      "API_URL:21",
    ]);
    expect(f.urlLiterals.map((u) => `${u.template} ${u.value} [${u.envVars}]`)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      "true ${getenv('API_URL')}/api/ping [API_URL]",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template form Link matches
      "true ${getenv('API_URL')}/v1/items [API_URL]",
      "false http://localhost:4000/data []",
    ]);
    expect(at(f.messages, (m: { kind: string; value: string }) => `${m.kind} ${m.value}`)).toEqual([
      "console cache miss:23",
      "throw report not found:31",
      "throw Not implemented yet:36",
    ]);
    expect(at(f.markers, (m: { kind: string }) => m.kind)).toEqual(["TODO:9"]);
    expect(at(f.stubs, (s: { symbol: string }) => s.symbol)).toEqual(["export:36"]);
  });

  it("finds PHPUnit and Pest tests and their skips", async () => {
    const unit = await parseFile(
      "tests/StoreTest.php",
      lines(
        "<?php",
        "use PHPUnit\\Framework\\TestCase;",
        "final class StoreTest extends TestCase",
        "{",
        "    public function testAdds(): void {}",
        "    #[Test]",
        "    public function exports(): void",
        "    {",
        "        $this->markTestSkipped('export is not built yet');",
        "    }",
        "    private function helper(): void {}",
        "}",
      ),
    );
    expect(unit?.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "testAdds:5:false:null",
      "exports:7:true:9",
    ]);
    const pest = await parseFile(
      "tests/Feature/NotesTest.php",
      lines(
        "<?php",
        "test('lists notes', function () {});",
        "it('exports', function () {})->skip();",
      ),
    );
    expect(pest?.tests.map((t) => `${t.name}:${t.line}:${t.skipped}:${t.skipLine}`)).toEqual([
      "lists notes:2:false:null",
      "exports:3:true:3",
    ]);
  });
});
