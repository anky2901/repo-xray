# 002-determinism

## Status

Accepted

## Context

Repo X-Ray needs outputs that are stable enough to diff, store, and compare across runs. Unstable ordering makes empty-result scans, history output, and analyzer output harder to trust and harder to review.

## Decision

Repo X-Ray uses explicit determinism helpers in `@repo-xray/core`:
- `sortFindings()` provides stable finding ordering before output or persistence-sensitive comparisons.
- `stableJson()` serializes objects with recursively sorted keys.
- `stableArtifactJson()` removes runtime metadata from canonical artifacts.
- `createDeterministicId()` derives ids from normalized input.

Runtime timing is stored under `meta.runtime` and excluded from canonical artifacts, comparisons, hashes, and snapshots.

## Consequences

- CLI JSON output is easier to diff in tests and in CI logs.
- Future analyzers have a single place to plug into stable ordering.
- Deterministic serialization is part of the codebase now, not just a documentation goal.
