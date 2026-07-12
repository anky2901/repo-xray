# Dependency Decisions

This document records the rationale for each dependency included in the Repo X-Ray project, enforcing supply chain safety and maintaining a minimal footprint.

## Foundational Dependencies

- **pnpm**: Chosen as the sole package manager for its strict workspace management, content-addressable storage, and integrity verification.
- **typescript**: Required for static typing across the monorepo.
- **eslint**: Standard linting enforcement.
- **@typescript-eslint/parser & @typescript-eslint/eslint-plugin**: Required to lint TypeScript code effectively.
- **prettier**: Code formatting for consistency.
- **vitest**: Fast, Vite-native testing framework. Preferred over Jest for native ESM and TypeScript support without Babel overhead.
- **tsup**: Zero-config bundler powered by esbuild. Used to build the `@repo-xray/*` packages efficiently without heavy Webpack/Rollup configuration.
- **@types/node**: Required for Node.js API typing.

## Shared Module

- **zod**: Used for robust, schema-based configuration parsing and runtime validation.

## Ingestion & Acquisition Module

- **simple-git**: Used to perform programmatic Git clone operations for remote repositories.
- **adm-zip**: Used to unpack compressed repository ZIP archives safely in the local workspace.

## Parser Module

- **acorn**: Lightweight JS/TS parser used to generate ASTs for dependency analysis.
- **acorn-walk**: AST walking utility to inspect AST import nodes.

## Storage Module

- **better-sqlite3**: Synchronous SQLite3 wrapper chosen for its performance, predictable execution (no async overhead), and robust PRAGMA controls for local-first storage.
- **@types/better-sqlite3**: Type definitions for the above.

## Cache Module

- **lru-cache**: Well-tested, performant LRU caching library with `maxSize` and customized size calculations to prevent unbounded memory growth.

## Export Module

- **puppeteer**: Headless browser automation library used to compile and render HTML reports to static PDF documents.

## CLI App

- **commander**: The defacto standard for building robust Node.js CLI interfaces, handling argument parsing and help generation efficiently.

## Web App

- The dashboard is rendered as a self-contained, dependency-free HTML document from a scan result (`renderDashboard`), so the web output has no runtime framework dependency.

---
**Policy Note**: All dependencies are locked to exact versions. Postinstall scripts are disabled globally via `.npmrc` (`ignore-scripts=true`). New dependencies require justification in this document.

