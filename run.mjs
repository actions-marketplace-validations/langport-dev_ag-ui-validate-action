#!/usr/bin/env node
// Driver for the composite action. Reads INPUT_* env vars (set by action.yml),
// runs the ag-ui-validate CLI, mirrors its exit code, writes GITHUB_OUTPUT,
// renders a findings table into $GITHUB_STEP_SUMMARY, and emits ::error/
// ::warning workflow commands so findings show up inline on the PR.
import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

const input = (name) => {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`]
  return v === undefined || v === "" ? undefined : v
}

const target = input("target")
if (target === undefined) {
  console.error("error: the 'target' input is required (URL, file path, or - for stdin)")
  process.exit(2)
}

// How to invoke the CLI, in order of precedence:
//  - AGUI_VALIDATE_CLI: explicit path to a cli.js (this repo's own self-test
//    pins an exact published version this way, rather than floating)
//  - version: <semver|latest> — the published package via npx, otherwise
const version = input("version") ?? "latest"
let command
let baseArgs
if (process.env.AGUI_VALIDATE_CLI !== undefined && process.env.AGUI_VALIDATE_CLI !== "") {
  command = process.execPath
  baseArgs = [process.env.AGUI_VALIDATE_CLI]
} else {
  command = "npx"
  baseArgs = ["--yes", `ag-ui-validate@${version}`]
}

// The action's own vocabulary over the CLI's mutually exclusive stdout
// flags. Independent of json-file below, which is always requested so the
// job summary and annotations have structured data to read regardless of
// what format the user chose for the log.
const FORMAT_FLAGS = { human: null, json: "--json", sarif: "--sarif", junit: "--junit", group: "--group" }
const format = input("format") ?? "human"
if (!(format in FORMAT_FLAGS)) {
  console.error(`error: 'format' must be one of ${Object.keys(FORMAT_FLAGS).join(", ")}, got '${format}'`)
  process.exit(2)
}

// RUNNER_TEMP is a per-job directory the runner cleans up itself, so a
// generated report survives for the rest of the job (report-path is a
// documented output) without this action having to manage cleanup.
const runnerTemp = process.env.RUNNER_TEMP ?? tmpdir()
const jsonFile = input("json-file") ?? join(runnerTemp, `ag-ui-validate-${randomUUID()}.json`)

const args = [...baseArgs, target, "--json-file", jsonFile]
if (FORMAT_FLAGS[format] !== null) args.push(FORMAT_FLAGS[format])
const failOn = input("fail-on")
if (failOn !== undefined) args.push("--fail-on", failOn)
const maxWarnings = input("max-warnings")
if (maxWarnings !== undefined) args.push("--max-warnings", maxWarnings)
const features = input("features")
if (features !== undefined) args.push("--features", features)
const timeout = input("timeout")
if (timeout !== undefined) args.push("--timeout", timeout)
const sarifFile = input("sarif-file")
if (sarifFile !== undefined) args.push("--sarif-file", sarifFile)
const junitFile = input("junit-file")
if (junitFile !== undefined) args.push("--junit-file", junitFile)
for (const rule of (input("rules") ?? "").split(/[\s,]+/).filter((r) => r !== "")) {
  args.push("--rule", rule)
}
for (const header of (input("headers") ?? "").split("\n").map((h) => h.trim()).filter((h) => h !== "")) {
  args.push("--header", header)
}

const result = spawnSync(command, args, { stdio: "inherit" })
const exitCode = result.status ?? 2

const appendTo = (envName, text) => {
  const path = process.env[envName]
  if (path !== undefined && path !== "") appendFileSync(path, text)
}

let report = null
try {
  report = JSON.parse(readFileSync(jsonFile, "utf8"))
} catch {
  // exit 2 before a report could be written (bad flags, unreachable target)
}

appendTo("GITHUB_OUTPUT", `exit-code=${exitCode}\n`)
if (report !== null) appendTo("GITHUB_OUTPUT", `report-path=${jsonFile}\n`)
if (sarifFile !== undefined) appendTo("GITHUB_OUTPUT", `sarif-path=${sarifFile}\n`)

// Workflow-command escaping per
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escapeProp = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C")
const ANNOTATION_COMMAND = { error: "error", warning: "warning" }
const MAX_ANNOTATIONS = 50

function emitAnnotations(diagnostics) {
  const isLocalFile = target !== "-" && !/^https?:\/\//.test(target)
  const annotatable = diagnostics.filter((d) => d.severity in ANNOTATION_COMMAND)
  for (const d of annotatable.slice(0, MAX_ANNOTATIONS)) {
    const props = [`title=${escapeProp(d.rule)}`]
    if (isLocalFile) {
      props.push(`file=${escapeProp(target)}`)
      if (d.eventIndex >= 0) props.push(`line=${d.eventIndex + 1}`)
    }
    const message = `${d.message} (${d.specUrl})`
    console.log(`::${ANNOTATION_COMMAND[d.severity]} ${props.join(",")}::${escapeData(message)}`)
  }
  if (annotatable.length > MAX_ANNOTATIONS) {
    console.log(`::notice::${annotatable.length - MAX_ANNOTATIONS} more findings not annotated — see the job summary or report files.`)
  }
}

if (report !== null) {
  const { errors, warnings, info } = report.summary
  appendTo("GITHUB_OUTPUT", `errors=${errors}\nwarnings=${warnings}\ninfo=${info}\n`)

  emitAnnotations(report.diagnostics)

  const md = ["## AG-UI conformance", "", `**Target:** \`${target}\``, ""]
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`
  if (report.diagnostics.length === 0) {
    md.push(`✅ No conformance violations across ${count(report.eventCount, "event")}.`)
  } else {
    md.push(
      `**${count(errors, "error")}, ${count(warnings, "warning")}, ${info} info** across ${count(report.eventCount, "event")}.`,
      "",
    )

    const byCategory = new Map()
    for (const d of report.diagnostics) {
      const key = d.category ?? "uncategorized"
      const bucket = byCategory.get(key) ?? { error: 0, warning: 0, info: 0 }
      bucket[d.severity] += 1
      byCategory.set(key, bucket)
    }
    md.push("| Category | Errors | Warnings | Info |", "|---|---|---|---|")
    for (const [category, counts] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      md.push(`| ${category} | ${counts.error} | ${counts.warning} | ${counts.info} |`)
    }
    md.push("")

    md.push("| Rule | Severity | Event | Message |", "|---|---|---|---|")
    const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ")
    for (const d of report.diagnostics.slice(0, 50)) {
      const where = d.eventIndex >= 0 ? d.eventIndex : "—"
      md.push(`| [${d.rule}](${d.specUrl}) | ${d.severity} | ${where} | ${cell(d.message)} |`)
    }
    if (report.diagnostics.length > 50) {
      md.push("", `…and ${report.diagnostics.length - 50} more findings (see the log or report files).`)
    }
  }
  const exercised = Object.values(report.features).filter((s) => s === "exercised").length
  md.push("", `${exercised} of ${Object.keys(report.features).length} AG-UI features exercised.`, "")
  appendTo("GITHUB_STEP_SUMMARY", `${md.join("\n")}\n`)
}

process.exit(exitCode)
