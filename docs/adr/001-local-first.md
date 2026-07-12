# 001-local-first

## Status

Accepted

## Context

Repository analysis tools often upload source code to a remote service. For many teams that is a
non-starter: the code is proprietary, subject to compliance constraints, or simply should not
leave the machine. We also want scans to be reproducible and usable offline.

## Decision

Repo X-Ray runs entirely on the local machine by default.

- Remote repositories are cloned locally (shallow) and analyzed from disk; nothing is uploaded.
- Analysis, scoring, and report generation happen in-process.
- The only outbound network calls are optional metadata lookups (OSV advisory data and npm
  registry freshness), which are cached and can be disabled with `--offline`.
- Results are written to the local output directory and a local SQLite history database.
- Telemetry is never collected.

## Consequences

- The tool works air-gapped once caches are warm.
- Source code never leaves the machine, which keeps it usable on proprietary codebases.
- Network-derived data (CVEs, package freshness) is a cache that may lag; `--offline` makes that
  trade-off explicit.
