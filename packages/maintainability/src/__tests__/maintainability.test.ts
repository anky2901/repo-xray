import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayMaintainabilityAnalyzer, estimateComplexity } from '../maintainability-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'maint-fixture');

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

describe('estimateComplexity', () => {
  it('counts decision points', () => {
    expect(estimateComplexity('const x = 1;')).toBe(1);
    expect(estimateComplexity('if (a) {} else if (b) {} for (;;) {}')).toBeGreaterThan(3);
  });
});

describe('XRayMaintainabilityAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags a long file', () => {
    write('src/big.ts', Array(450).fill('const x = 1;').join('\n'));
    const analysis = new XRayMaintainabilityAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.map((f) => f.title)).toContain('Long File');
  });

  it('flags a highly complex file', () => {
    const fn = (i: number) => `function f${i}(a, b) { if (a) { if (b) { for (;;) { while (a && b) { return a || b; } } } } }`;
    write('src/complex.ts', Array(20).fill(0).map((_, i) => fn(i)).join('\n') + '\n' + Array(40).fill('if (x && y || z) {}').join('\n'));
    const analysis = new XRayMaintainabilityAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.some((f) => f.title === 'High Cyclomatic Complexity')).toBe(true);
    expect(analysis.avgComplexity).toBeGreaterThan(0);
  });

  it('returns a clean, full-score report for a small tidy codebase', () => {
    write('src/a.ts', '// a helper\nexport const a = 1;\n');
    write('src/b.ts', '// b helper\nexport const b = 2;\n');
    const analysis = new XRayMaintainabilityAnalyzer().analyze(makeContext(root));
    expect(analysis.findings).toHaveLength(0);
    expect(analysis.score).toBe(100);
    expect(analysis.report).toContain('Maintainability Score: 100/100');
  });

  it('exposes scan() and exportReport()', async () => {
    write('src/a.ts', 'export const a = 1;');
    const analyzer = new XRayMaintainabilityAnalyzer();
    expect(Array.isArray(await analyzer.scan(makeContext(root)))).toBe(true);
    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Maintainability Report');
    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
