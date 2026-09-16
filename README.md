# Task Verdict — Agent Deck SKU #39

Orchestration receipts: turn any delegated task's claims into **checkable evidence**. A task manifest (`cwi.task-verdict/1.0`) lists evidence-bound checks; the runner executes them and emits a machine-readable verdict record (`cwi.task-verdict-record/1.0`) with **PASS / FAIL / PARTIAL**.

Live: https://cumulativewebinc.github.io/cwi-task-verdict/

## Why

Subagents report success; success is asserted, not evidenced. The recurring complaints are well documented (agents-radar AI CLI Tools Digest, 2026-08-08): subagents hanging (#21409), reporting false success (#22323), running without permission (#22093) — "agent orchestration robustness is the single biggest trust barrier for users." Task Verdict is the receipt layer: the coordinator writes the checks *before* delegating, the runner executes them *after*, and the verdict is computed from evidence — never from the subagent's prose.

## Files

- `index.html` — Run tab (paste/upload a manifest, execute browser URL checks, GitHub-Checks-style verdict display, `?manifest=` deep links, verdict JSON download), Assemble tab (build a manifest row-by-row without hand-writing JSON), Honest-limits tab. i18n hook in-page (`window.TaskVerdictI18N`).
- `styles.css` — dark checks-console theme.
- `verdict.js` — zero-dependency UMD engine: manifest parsing + validation, 7 check types, verdict computation, canonical JSON records. Works in browsers and Node. Byte-identical served copy is verified at deploy.
- `cli/verify.js` — Node CLI: `node cli/verify.js <manifest.json> [--base <dir>] [--out <verdict.json>]`. Exit codes: 0 PASS · 2 FAIL · 3 PARTIAL · 1 usage/manifest error. Entry-point guarded for safe importing.
- `schema/task-verdict.schema.json` — `cwi.task-verdict/1.0` (the manifest).
- `schema/verdict-record.schema.json` — `cwi.task-verdict-record/1.0` (the receipt).
- `tests/test.js` — `node --test`, 38 real tests (live local HTTP server, real temp files, real CLI subprocesses).
- `tests/fixtures/server.js` — fixture HTTP server for CLI tests (own process; avoids the spawnSync event-loop deadlock).
- `dogfood/` — real manifests + verdict records: trust-line products' live URLs, identity-line products, and this product's own ship checklist.

## Check types

| type | proves | env |
|---|---|---|
| `url_status` | URL answers with the expected HTTP status | browser + CLI |
| `url_contains` | fetched page body matches a pattern | browser + CLI |
| `file_exists` | file exists under the base dir | CLI |
| `file_sha256` | file bytes match an expected hash | CLI |
| `file_regex` | file content matches a pattern | CLI |
| `json_field` | a JSON field equals an expected value | CLI |
| `count_match` | a pattern occurs ≥ N times in a file | CLI |

URL fetches carry a timeout (`timeout_ms` per check or manifest, default 15000ms) — a hung server yields ERROR, never a hung verifier. File checks are sandboxed to one base directory; traversal outside it is rejected as ERROR.

## Verdict semantics

- **PASS** — every check passed. Proves the listed checks passed at run time, not that the task was "good".
- **FAIL** — at least one check's observed evidence contradicted the claim.
- **PARTIAL** — something could not be verified (network error, timeout, CORS block). Unverifiable is reported as unverifiable — never rounded up to a pass.

## Run tests

```sh
node --test tests/test.js   # 38/38 green
```

## Dogfood

```sh
node cli/verify.js dogfood/memory-seal.json --out dogfood/verdicts/memory-seal.verdict.json
node cli/verify.js dogfood/identity-ledger.json --out dogfood/verdicts/identity-ledger.verdict.json
node cli/verify.js dogfood/self-local.json --base . --out dogfood/verdicts/self-local.verdict.json
```

## Honest limits

- A PASS proves the listed checks passed at run time — not that the task was good, complete, or honest.
- An ERROR means "could not verify", never "passed".
- Browser URL checks are CORS-limited; the CLI is the authority for URL checks.
- This is heuristic triage for orchestration claims: receipts over assertions, evidence over adjectives.
