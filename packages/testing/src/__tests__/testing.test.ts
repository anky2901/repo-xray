import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayTestingAnalyzer } from '../testing-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'testing-fixture');

function makeContext(workspacePath: string): ScanContext {
  return {
    workspacePath,
    repoMeta: {
      name: 'fixture',
      source: 'local',
      languages: {},
      frameworks: [],
      packageManagers: [],
      totalFiles: 0,
      totalLines: 0,
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
    config: { output: { dir: workspacePath, formats: [] } },
    cache: { get: async () => null, set: async () => {}, invalidate: async () => {}, clear: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    mode: 'deep',
  };
}

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('XRayTestingAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags a codebase with source files but no tests', () => {
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    write('src/c.ts', 'export const c = 3;');
    const analysis = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(analysis.testFiles).toBe(0);
    expect(analysis.findings.map((f) => f.title)).toContain('No Test Files Detected');
  });

  it('parses coverage-summary.json when present', () => {
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    write('src/c.ts', 'export const c = 3;');
    write('coverage/coverage-summary.json', JSON.stringify({ total: { lines: { pct: 42 } } }));
    const analysis = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(analysis.coveragePercent).toBe(42);
    expect(analysis.coverageEstimated).toBe(false);
    expect(analysis.findings.map((f) => f.title)).toContain('Low Test Coverage');
  });

  it('computes line coverage from lcov.info', () => {
    write('src/a.ts', 'export const a = 1;');
    write('coverage/lcov.info', 'SF:src/a.ts\nLF:10\nLH:9\nend_of_record\n');
    const analysis = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(analysis.coveragePercent).toBe(90);
    expect(analysis.coverageEstimated).toBe(false);
  });

  it('detects flaky timing patterns and skips when fake timers are configured', () => {
    write('src/a.ts', 'export const a = 1;');
    write('test/flaky.test.ts', 'test("x", () => { const now = Date.now(); expect(now).toBeDefined(); });');
    const flaky = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(flaky.findings.some((f) => f.tags.includes('flaky'))).toBe(true);

    fs.rmSync(path.join(root, 'test', 'flaky.test.ts'));
    write('test/safe.test.ts', 'vi.useFakeTimers();\ntest("x", () => { const now = Date.now(); expect(now).toBeDefined(); });');
    const safe = new XRayTestingAnalyzer().analyze(makeContext(root));
    const timeFlaky = safe.findings.filter((f) => f.title.includes('Time-dependent'));
    expect(timeFlaky).toHaveLength(0);
  });

  it('flags unmocked network calls in tests', () => {
    write('src/a.ts', 'export const a = 1;');
    write('test/net.test.ts', 'test("x", async () => { const r = await fetch("https://api.example.com"); expect(r).toBeDefined(); });');
    const analysis = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.some((f) => f.title.includes('Unmocked network'))).toBe(true);
  });

  it('estimates coverage from file ratio when no coverage report exists', () => {
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    write('src/__tests__/a.test.ts', 'test("a", () => expect(1).toBe(1));');
    const analysis = new XRayTestingAnalyzer().analyze(makeContext(root));
    expect(analysis.coverageEstimated).toBe(true);
    expect(analysis.coveragePercent).not.toBeNull();
  });
});
