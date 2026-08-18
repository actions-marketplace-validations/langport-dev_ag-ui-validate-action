# ag-ui-validate

[![CI](https://github.com/langport-dev/ag-ui-validate-action/actions/workflows/ci.yml/badge.svg)](https://github.com/langport-dev/ag-ui-validate-action/actions/workflows/ci.yml)

Validate an [AG-UI](https://docs.ag-ui.com) agent endpoint or recorded event
stream for protocol conformance, in CI. A thin composite-action wrapper
around the [`ag-ui-validate`](https://github.com/langport-dev/ag-ui-validate)
CLI: every rule, message, and spec citation comes straight from that project
— this repo is argv construction and output formatting only.

## Usage

```yaml
- uses: langport-dev/ag-ui-validate-action@v1
  with:
    target: http://localhost:8000/agui   # or a recorded .jsonl / SSE capture
```

That's the whole zero-config case: it validates `target`, fails the step on
error-severity findings, and writes a findings table to the job summary.

### Validating a live agent

Most real usage boots the agent under test as a background step first, then
points the action at it:

```yaml
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      # Start the agent in the background; give it a moment to bind its port.
      - name: Start the agent
        run: |
          npm run start:agent &
          npx wait-on http://localhost:8000/agui -t 30000

      - uses: langport-dev/ag-ui-validate-action@v1
        with:
          target: http://localhost:8000/agui
          features: agentic-chat,shared-state
```

### Report-only (don't fail the build)

```yaml
- uses: langport-dev/ag-ui-validate-action@v1
  with:
    target: http://localhost:8000/agui
    fail-on: none
```

Findings still show up in the job summary and as PR annotations; the step
itself always exits 0.

### Code scanning (SARIF)

```yaml
- uses: langport-dev/ag-ui-validate-action@v1
  with:
    target: recordings/run.jsonl
    sarif-file: agui.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: agui.sarif
```

Findings then also appear in the repo's **Security → Code scanning** tab,
grouped by category via SARIF tags.

## Where findings show up

Two surfaces, both populated on every run:

- **Job summary** — a findings table (rule, severity, event, message, each
  rule linking to its governing spec section) plus a counts-by-category
  breakdown, rendered on the Actions run page. This is the most visible
  thing the action produces; it needs no clicking into logs.
- **PR annotations** — `::error`/`::warning` workflow commands, one per
  error- and warning-severity finding, so violations appear inline on the
  "Files changed" tab of a PR when `target` is a file in the checkout.
  (Findings against a live endpoint still annotate, just without a
  file/line — the message carries the rule and spec link instead.)

Every diagnostic in both surfaces links back to the AG-UI spec section that
governs it.

## Inputs

| Input | Description |
| --- | --- |
| `target` (required) | Endpoint URL, recorded stream file (JSONL/NDJSON or SSE capture), or `-` for stdin |
| `version` | Package version to run via npx (default `latest`); `local` uses the `dist/` build in this checkout (repo self-test only) |
| `format` | Stdout format: `human` (default), `json`, `sarif`, `junit`, or `group` (one line per rule with a count) |
| `fail-on` | Severity that fails the step: `error` (default), `warning`, or `none` (report-only) |
| `max-warnings` | Fail when warning-severity findings exceed this number |
| `features` | Comma-separated declared features (enables feature-conditional rules) |
| `rules` | Whitespace-separated severity overrides, e.g. `AGUI105=error AGUI902=off` |
| `headers` | Extra request headers for endpoint targets, one `Name: value` per line |
| `timeout` | Abort an endpoint request after this many seconds |
| `sarif-file` / `junit-file` / `json-file` | Also write these report formats to files |

## Outputs

| Output | Description |
| --- | --- |
| `exit-code` | The CLI's exit code: `0` clean, `1` findings, `2` tool failure |
| `errors` / `warnings` / `info` | Finding counts by severity |
| `sarif-path` | Path to the written SARIF log, if `sarif-file` was set |
| `report-path` | Path to the JSON report (always written, backs the job summary) |

## Versioning

`v1` is a moving tag, retargeted to the latest `v1.x.y` on every release —
pin to an exact `v1.2.3` tag instead if you want immutability. The action
itself has no logic of its own to version around; behavior changes track
the [`ag-ui-validate`](https://github.com/langport-dev/ag-ui-validate) CLI,
pinned per-run via the `version` input (default `latest`). Pin `version` to
an exact CLI release if you want a validator upgrade to never surprise a
build.

## Development

This repo has no source of its own beyond `action.yml` and `run.mjs` — all
validation logic lives in the
[`ag-ui-validate`](https://github.com/langport-dev/ag-ui-validate) CLI. If
this action needs new behavior, it almost always means a CLI flag needs to
exist first; extend the CLI, then wire it through here as another input.

`.github/workflows/ci.yml` runs this action against itself on every push,
using the fixture corpus from the main repo and a pinned published CLI
version.
