import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayCodeStyleAnalyzer } from '../codestyle-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'style-fixture');

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

describe('XRayCodeStyleAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags trailing whitespace and long lines', () => {
    write('src/a.ts', "const a = 1;   \nconst b = 2;\n");
    write('src/b.ts', `const long = "${'x'.repeat(140)}";\n`);
    const analysis = new XRayCodeStyleAnalyzer().analyze(makeContext(root));
    const titles = analysis.findings.map((f) => f.title);
    expect(titles).toContain('Trailing Whitespace');
    expect(titles).toContain('Long Lines');
  });

  it('detects mixed indentation across a codebase', () => {
    for (let i = 0; i < 3; i++) write(`src/tab${i}.ts`, '\tconst x = 1;\n\tconst y = 2;\n');
    for (let i = 0; i < 3; i++) write(`src/space${i}.ts`, '  const x = 1;\n  const y = 2;\n');
    const analysis = new XRayCodeStyleAnalyzer().analyze(makeContext(root));
    expect(analysis.stats.indentStyle).toBe('mixed');
    expect(analysis.findings.map((f) => f.title)).toContain('Mixed Indentation Style');
  });

  it('returns a clean full-score report for consistent style', () => {
    write('src/a.ts', "const a = 1;\nconst b = 2;\n");
    const analysis = new XRayCodeStyleAnalyzer().analyze(makeContext(root));
    expect(analysis.findings).toHaveLength(0);
    expect(analysis.score).toBe(100);
  });

  it('exposes scan() and exportReport()', async () => {
    write('src/a.ts', 'const a = 1;   \n');
    const analyzer = new XRayCodeStyleAnalyzer();
    expect(Array.isArray(await analyzer.scan(makeContext(root)))).toBe(true);
    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Code Style Report');
    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
