# Repo X-Ray

Local-first repository intelligence. Point it at a repo and it produces explainable,
deterministic reports on security, architecture, dependencies, tests, CI, release readiness,
maintainability, performance, git health, code style, business context, and more — plus
copy-paste AI prompts and fix suggestions.

- **Local-first:** clones/copies the repo and analyzes it on your machine. No data leaves by default.
- **Deterministic:** the same input produces byte-identical `scan.json` and reports.
- **Explainable:** every finding carries evidence, a confidence score, and plain-English reasoning.
- **Offline-capable:** works from cache with `--offline`; network is only used for CVE/registry lookups.

## Requirements

- Node.js >= 18 (tested on 22)
- pnpm 10+
- git on PATH (for scanning GitHub URLs and git-history analysis)

## Setup

```bash
pnpm install
pnpm build
```

Verify your environment at any time (either form works — see "The `xray` command" below):

```bash
node apps/cli/dist/index.js doctor
```

## Quick start

Scan a GitHub repo (zero config):

```bash
xray scan https://github.com/expressjs/express --mode=deep
```

Reports are written to `.xray-reports/` by default. Open `.xray-reports/DASHBOARD.html` in a
browser for the interactive view, or read `REPORT.md` for the summary.

## How to use

A full walkthrough, from install to reading results.

### 1. Install and build

```bash
pnpm install
pnpm build
```

### 2. Check your environment

```bash
node apps/cli/dist/index.js doctor
```

This confirms Node, pnpm, git, SQLite, cache access, and disk space. Fix anything it reports as
`FAIL` before scanning.

### 3. Run your first scan

Pick a target — a local folder, a GitHub URL, or a `.zip` archive — and choose a mode. For a full
review, use `deep`:

```bash
# a local project
node apps/cli/dist/index.js scan ./path/to/project --mode=deep

# a remote repository
node apps/cli/dist/index.js scan https://github.com/expressjs/express --mode=deep

# the current directory
node apps/cli/dist/index.js scan . --mode=deep
```

Use `--output=<dir>` to write reports somewhere other than `.xray-reports/`.

### 4. Read the results

After a scan, look at the output directory (default `.xray-reports/`):

- **`DASHBOARD.html`** — open in a browser for the interactive view: score cards, a severity
  summary, and a filterable findings table. Start here.
- **`REPORT.md`** — the text summary with the health scorecard and the top findings.
- **Topic reports** — drill into a specific area: `SECURITY.md`, `DEPENDENCY.md`,
  `ARCHITECTURE.md`, `TEST_PLAN.md`, `RELEASE.md`, and the rest (full list under
  [Output files](#output-files-deep-mode)).
- **`FIXES.md`** — a prioritized, copy-paste list of concrete fixes.
- **`scan.json`** — the full machine-readable result if you want to script against it.

Every finding includes the file/line evidence, a confidence score, and a plain-English reason.

### 5. Pick the right mode for the job

- Quick triage or pre-commit: `--mode=quick` (security only, fastest).
- Full review: `--mode=deep` (all modules).
- Deep audit: `--mode=paranoid`.
- Inside a pipeline: `--ci --fail-on=HIGH` (machine output + exit codes).

### 6. Common workflows

```bash
# Gate a CI build: non-zero exit on HIGH or CRITICAL findings
node apps/cli/dist/index.js scan . --ci --fail-on=HIGH

# Quick release-readiness check (release + CI health only)
node apps/cli/dist/index.js release-check .

# Generate AI prompts grounded in this repo's real facts
node apps/cli/dist/index.js prompts .

# Re-scan without network access, using cached CVE/registry data
node apps/cli/dist/index.js scan . --mode=deep --offline

# Compare two past scans from the local history
node apps/cli/dist/index.js history <repoId>
node apps/cli/dist/index.js compare <scanId1> <scanId2>
```

> Tip: the examples above use the long form so they work immediately after `pnpm build`. To use
> the shorter `xray <command>` form, see [The `xray` command](#the-xray-command) below.

## The `xray` command

The CLI package ships a `bin` named `xray`. To use it as a global command:

```bash
pnpm --filter @repo-xray/cli build   # ensure dist is built
pnpm setup                           # one-time: creates pnpm's global bin dir (restart shell after)
pnpm --filter @repo-xray/cli link --global
xray --help
```

If you prefer not to set up a global bin, every command also works via:

```bash
node apps/cli/dist/index.js <command>
```

Both forms are equivalent; the examples below use `xray`.

## Commands

### `scan <source>`
Scan a local path, GitHub URL, or `.zip` archive.

| Option | Description |
|---|---|
| `--mode <mode>` | `quick` (security only, fast), `deep` (all modules), `paranoid` (all + extra passes), `ci` (machine output + exit codes). Default: `quick`. |
| `--output <dir>` | Output directory for reports. Default: `.xray-reports`. |
| `--offline` | Use only cached data; skip live CVE/registry lookups. |
| `--ci` | Machine-friendly run with CI exit codes (implies `ci` mode). |
| `--fail-on <severity>` | In CI mode, exit non-zero when a finding at or above this severity exists (e.g. `HIGH`). |

Examples:

```bash
# Fast security-focused pass on the current directory
xray scan . --mode=quick

# Full analysis of a local project into a custom folder
xray scan ./my-app --mode=deep --output=reports/

# CI gate: fail the build on HIGH+ findings
xray scan . --ci --fail-on=HIGH

# Offline re-scan using cached CVE/registry data
xray scan https://github.com/user/repo --mode=deep --offline
```

CI exit codes: `0` clean, `1` findings below threshold, `2` HIGH present, `3` CRITICAL present.

### `release-check <source>`
Fast path that runs only release readiness (M17) + CI health (M18). Writes `RELEASE.md`,
`RELEASE_CHECKLIST.md`, `CI_REPORT.md`.

```bash
xray release-check . --output=reports/
```

### `prompts <source>`
Generate copy-paste AI prompts grounded in the repo's actual facts. Writes
`PROMPTS/{dev,bugfix,feature,audit,onboarding}.md`.

```bash
xray prompts .
```

### `history [repoId]`, `compare <id1> <id2>`
Query and diff past scans stored in the SQLite history (`.xray-reports/xray.db`).

```bash
xray history <repoId>
xray compare <scanId1> <scanId2>
```

### `config`, `doctor`
`config` prints the resolved configuration; `doctor` runs environment diagnostics.

## Scan modes

| Mode | Modules | Use for |
|---|---|---|
| `quick` | Security only | Fast pre-commit / triage |
| `deep` | All modules | Full review (default recommendation) |
| `paranoid` | All modules + extra passes | Deep audits |
| `ci` | All modules, machine output, exit codes | Pipelines |

## Output files (deep mode)

| File | Contents |
|---|---|
| `REPORT.md` | Master summary + health scorecard + badge |
| `DASHBOARD.html` | Interactive, filterable dashboard |
| `SECURITY.md` | Secrets, dangerous patterns, config issues, CVEs (secrets always masked) |
| `ARCHITECTURE.md` / `ARCHITECTURE.html` | Import graph, cycles, god files, layering, dead modules |
| `DEPENDENCY.md` | Vulnerable/duplicate/abandoned/oversized deps, license conflicts |
| `TEST_PLAN.md` | Coverage, gaps, flaky-test patterns |
| `RELEASE.md` / `RELEASE_CHECKLIST.md` | Weighted release-readiness scorecard + checklist |
| `CI_REPORT.md` | Workflow health: tests, pinned actions, secrets, permissions, timeouts |
| `MAINTAINABILITY.md` | Complexity, file size, comment density, hotspots |
| `PERFORMANCE.md` | Static performance hotspots |
| `GIT.md` | Commit velocity, contributors, bus factor, churn hotspots |
| `CODE_STYLE.md` | Indentation/quote consistency, trailing whitespace, long lines |
| `BUSINESS.md` | Inferred purpose, domain, users, distribution |
| `VULN_REPORT.md` | Per-vulnerability fixes (minimal + best-practice + AI prompt + test) |
| `ADOPTION.md` | Adoption-potential estimate with confidence interval |
| `FIXES.md` | Consolidated, severity-grouped fix suggestions |
| `PROMPTS/*.md` | AI prompts grounded in extracted repo facts |
| `scan.json` | Full structured result (schema 1.0), deterministic |
| `scan.sarif` | SARIF 2.1.0 for GitHub Code Scanning |
| `scan.pdf` | Rendered when a Chrome runtime is available (skipped gracefully otherwise) |

## Configuration

Zero config works out of the box. To customize, add a `.xrayrc.json` at the repo root, set
`XRAY_*` environment variables, or pass CLI flags (CLI overrides env overrides file overrides
defaults). Common settings: `output.dir`, `cache.dir`, `ignore.patterns`, `github.token`,
`ai.provider`. Telemetry is always off.

Ignore rules: honors `.gitignore` by default; add repo-specific exclusions in `.xrayignore`.

## Using the SDK

Everything is available programmatically through `@repo-xray/sdk`:

```ts
import { XRayPipeline, FileCache, loadConfig, logger, renderDashboard } from '@repo-xray/sdk';

const config = loadConfig();
const result = await new XRayPipeline().run({
  source: './my-app',
  mode: 'deep',
  modules: ['security', 'architecture', 'dependency', 'test-intelligence', 'release', 'ci-health'],
  config,
  cache: new FileCache(config.cache.dir),
  logger,
});

console.log(result.scores);
const html = renderDashboard(result); // self-contained dashboard HTML
```

## Development

```bash
pnpm typecheck   # strict TypeScript across all packages
pnpm lint        # eslint
pnpm test        # vitest
pnpm build       # lint + build all packages
```

The repo is a pnpm workspace: `apps/` (cli, web), `packages/` (sdk, core, per-module analyzers,
cache, storage, export, reporting), and `shared/`. Apps depend only on the SDK; analyzers depend
on `@repo-xray/types`. This boundary is enforced by a test.
