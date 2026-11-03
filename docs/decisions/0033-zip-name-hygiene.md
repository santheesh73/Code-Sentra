# 0033 — Zip entry name hygiene

- **Status:** accepted (remediation WS-4)

## Context

The audit (F-09) found zip entry-name validation rejecting only C0 control characters. A name
could still carry DEL, C1 controls, Unicode bidirectional overrides (U+202E and friends) and
zero-width characters. There was no path escape, but such a name can display as something it is
not — `invoice‮pdf.exe` shows as `invoiceexe.pdf` — in the report, a fix prompt, a GitHub
check summary or the CLI. Duplicate detection folded case but not Unicode normal form, so
`café.txt` in NFC and NFD could appear as two files.

## Decision

- **Reject hostile characters at ingest** (`checkEntryName`). An entry name containing a C0 or
  C1 control character, DEL, a bidirectional control (marks, embeddings, overrides, isolates,
  the Arabic letter mark), a zero-width character or the byte-order mark is refused
  (`bad_name`). Rejecting at ingest means no later view ever has to re-escape: a name that
  reaches the report, a prompt, a check summary or the CLI is already free of these.
- **Store names in NFC and detect normal-form collisions.** `checkEntryName` returns the name
  normalized to NFC, so a decomposed (NFD) name — common from macOS — is stored in one
  canonical form. Duplicate detection keys on NFC + lower-case, so NFC/NFD and case variants of
  the same name collide (`duplicate_path`) instead of producing two files, one shadowing the
  other.
- **Legitimate Unicode names are kept, not rejected.** A decomposed accented filename extracts
  once, as its NFC form; only the dangerous character classes above are refused. (Chosen over
  blanket rejection of non-NFC names, which would break valid macOS-authored archives.)

## Consequences

- A crafted archive can no longer smuggle a misleading filename into any CodeSentra surface,
  and can no longer land two files whose names differ only by normal form or case.
- The character list is explicit in `zip.ts` (`DISALLOWED_NAME_CHARS`) and covered by tests,
  including the audit's control-character and right-to-left-override cases and an NFC/NFD
  collision. React escapes HTML in the web UI, so the remaining concern these controls posed
  was visual spoofing, which rejection removes.
