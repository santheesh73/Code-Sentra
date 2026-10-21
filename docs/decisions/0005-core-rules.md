# 0005 — Shared rules in `packages/core`

- **Status:** accepted (Phase 0)

## Decisions

1. **Finding-code declarations.** Each code declares its module, default severity, prompt
   type, `requiresTrace`, `specificity` and a re-check descriptor. Pulse `code_fix` codes
   set `requiresTrace`, so without a verified trace the prompt type falls back to
   `investigate` (Section 10c). `specificity` picks the lead code when findings that share
   evidence merge: `UNDEFINED_IN_URL` (90) leads `SAME_ORIGIN_FAILURE` (60).
2. **Fingerprints** are `sha256(code \n normalizedLocator [\n normalizedDiscriminator])`.
   Pulse locators drop the query, fragment, Next.js build id, asset content hashes and
   trailing `:line:col`. Scan locators keep `path#symbol` and drop line numbers. The
   optional discriminator, a whitespace-normalized message, keeps console errors on the
   same URL apart ("never merged by URL").
3. **Hashing** lives in the `@codesentra/core/hashing` subpath because it uses
   `node:crypto`. The main entry stays isomorphic so `apps/web` can import enums and schemas.
4. **The Pulse status rule** follows Section 9 exactly. In addition, a run that recorded no
   check groups is `unverified`, never `live`. A skipped group with no stated reason gets an
   explicit "no reason recorded" gap.
5. **The issue lifecycle** (`nextIssueStatus`) never changes status when the check group
   did not run. `regressed` resolves again once fixed. `dismissed` only changes through
   explicit user action.
6. **The Pulse `routes` group** probes same-origin links found on the rendered page, plus
   Scan routes when a Scan exists. Without that, `broken-route` (`/pricing` is linked but is
   not a Scan route) is undetectable, and a URL-only `healthy` check could never be `live`.
   The method and limit rules from Section 9.4 still apply.
