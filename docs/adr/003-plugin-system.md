# 003-analyzer-modules

## Status

Accepted

## Context

Repo X-Ray covers many concerns — security, architecture, dependencies, tests, CI, release
readiness, maintainability, performance, git, code style, and business context. Bundling all of
that into one pass would be hard to test, hard to reason about, and hard to extend.

## Decision

Each concern is an independent analyzer package under `packages/` that implements a common
`Analyzer` contract from `@repo-xray/types` (`scan(context)` plus a report builder). The pipeline
in `@repo-xray/core` selects analyzers by scan mode, runs the independent ones concurrently,
merges their findings, and lets each contribute a report file and a score.

- Analyzers depend only on `@repo-xray/types` (and `@repo-xray/shared` for utilities), never on
  the pipeline, keeping the dependency direction acyclic.
- Adding a capability means adding a package and registering it in the pipeline; nothing else
  needs to change.
- Findings share one shape (evidence, confidence, reasoning), so the trust layer, exporters, and
  dashboard treat every analyzer uniformly.

## Consequences

- Analyzers are unit-testable in isolation with a mock `ScanContext`.
- Scan modes (quick/deep/paranoid/ci) are just different analyzer selections.
- The uniform finding shape is a contract: changing it is a cross-cutting change, so it is kept
  small and stable.
