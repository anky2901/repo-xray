import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayPerformanceAnalyzer } from '../performance-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'perf-fixture');

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

describe('XRayPerformanceAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags await inside a loop', () => {
    write('src/a.ts', 'async function f(items) {\n  for (const i of items) {\n    await save(i);\n  }\n}');
    const analysis = new XRayPerformanceAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.some((f) => f.title === 'await inside loop')).toBe(true);
  });

  it('flags JSON deep clone', () => {
    write('src/b.ts', 'const copy = JSON.parse(JSON.stringify(obj));');
    const analysis = new XRayPerformanceAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.some((f) => f.title === 'JSON deep clone')).toBe(true);
  });

  it('flags blocking synchronous file I/O', () => {
    write('src/c.ts', 'const data = readFileSync("./x.json");');
    const analysis = new XRayPerformanceAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.some((f) => f.title === 'Blocking synchronous file I/O')).toBe(true);
  });

  it('returns a clean full-score report when no hotspots exist', () => {
    write('src/clean.ts', 'export const add = (a: number, b: number) => a + b;');
    const analysis = new XRayPerformanceAnalyzer().analyze(makeContext(root));
    expect(analysis.findings).toHaveLength(0);
    expect(analysis.score).toBe(100);
    expect(analysis.report).toContain('No common performance anti-patterns detected');
  });

  it('exposes scan() and exportReport()', async () => {
    write('src/b.ts', 'const copy = JSON.parse(JSON.stringify(obj));');
    const analyzer = new XRayPerformanceAnalyzer();
    expect((await analyzer.scan(makeContext(root))).length).toBeGreaterThan(0);
    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Performance Report');
    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
