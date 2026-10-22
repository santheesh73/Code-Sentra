# 0020 — Traces join runtime evidence to stored code facts, exactly

- **Status:** accepted (Phase 4)

## Context

Section 10a: a trace is `verified` only when the join key from the runtime evidence
matches a code fact exactly, with no fuzzy or LLM matching. Link runs in its own worker,
after the Scan worker is done with the snapshot. Scan never stored the facts these joins
need: URL templates and their env vars, hrefs, and error messages.

## Decision

- **Parsers record the facts:**
  - URL literals and URL templates, with their line text and interpolated env vars;
  - JSX `href` values;
  - error messages: `throw new Error("x")` / Python `raise X("x")` (throw),
    `new Error("x")` (error), and `console.error("x")` (console);
  - the module's default export (a Next.js page component).
- **The graph stores them as `literal` code nodes** (`meta.role`: url, url_template,
  href, throw, error, console), with the line and source text. Next.js file routes point
  at the page component's line. Co-change pairs become `co_changes` edges. Migration
  0006 adds the node kind.
- **`packages/link` (pure functions) traces each code with one rule:**

  | Finding                               | Join key                                                                               | Matches                                                                                                                                                                   |
  | ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `UNDEFINED_IN_URL`                    | path after the bad token (`/api/ping`)                                                 | a URL template whose static suffix (after the last `${…}`) equals it                                                                                                      |
  | `LOCALHOST_CALL`                      | `host[:port]` as the browser saw it                                                    | a URL literal with that host and port                                                                                                                                     |
  | `SAME_ORIGIN_FAILURE`, `ROUTE_BROKEN` | request path                                                                           | a route or handler whose pattern matches it (`[id]`, `:id`, `{id}`, `[...slug]`). No match: the code becomes `ROUTE_MISSING`, traced to the `href` or call with that path |
  | `UNCAUGHT_EXCEPTION`, `CONSOLE_ERROR` | message without the runtime prefix (`Uncaught Error: `) and with whitespace normalized | a throw, Error or console.error literal with the same text                                                                                                                |
  | `BLANK_PAGE`                          | page path                                                                              | the page component for it                                                                                                                                                 |
  | Scan codes                            | their `path:line`                                                                      | that file. The project-level locator `.` is never traced                                                                                                                  |

- **A site has its file, line, enclosing symbol (the nearest preceding one), the stored
  source line, and its env vars.** The project-documented flag comes from Scan's
  `env_var_documented` evidence. At most 5 sites are kept.
- **Blast radius:** files that import (or call into) a traced file, up to 2 hops, plus
  that file's top 5 co-change partners. Each entry has its reason.
- **`traces` rows are written only when verified** (a check constraint). They are
  replaced each time Link re-traces the issue. An untraced issue has no rows, and its
  prompt is an `investigate` "unconfirmed lead".

## Consequences

- Each rule is tested against every fixture app: real Pulse findings, the real parse of
  the app's source, and the file, line and join key from its manifest.
- Code the parsers cannot see stays untraced rather than guessed. Examples: a URL built
  from several variables with no static suffix, or a message assembled at runtime.
- A reclassified issue (`ROUTE_MISSING`) has its own fingerprint, so an earlier
  `ROUTE_BROKEN` issue for the same path resolves when the new one opens.
