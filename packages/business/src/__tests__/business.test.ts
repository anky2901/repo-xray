import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayBusinessAnalyzer } from '../business-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'business-fixture');

function makeContext(workspacePath: string, frameworks: string[] = [], entrypoints: string[] = []): ScanContext {
  return {
    workspacePath,
    repoMeta: {
      name: 'demo',
      source: 'local',
      languages: { TypeScript: 100 },
      frameworks,
      packageManagers: ['npm'],
      totalFiles: 5,
      totalLines: 200,
      entrypoints,
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
    config: { output: { dir: workspacePath, formats: [] } },
    cache: { get: async () => null, set: async () => {}, invalidate: async () => {}, clear: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    mode: 'deep',
  };
}

describe('XRayBusinessAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('infers a developer-tooling domain from description keywords', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', description: 'A CLI scanner and linter for repositories', keywords: ['cli', 'scanner'] }));
    const analysis = new XRayBusinessAnalyzer().analyze(makeContext(root, [], ['bin/cli.js']));
    expect(analysis.profile.domain).toBe('Developer tooling');
    expect(analysis.profile.primaryUsers).toContain('Developers');
    expect(analysis.profile.purpose).toContain('CLI scanner');
  });

  it('infers a backend domain from an Express framework', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'api', description: 'REST API server' }));
    const analysis = new XRayBusinessAnalyzer().analyze(makeContext(root, ['Express'], ['src/server.ts']));
    expect(analysis.profile.domain).toBe('Backend service / API');
  });

  it('flags an undocumented purpose when no description or README exists', () => {
    const analysis = new XRayBusinessAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.map((f) => f.title)).toContain('Undocumented Purpose');
  });

  it('uses the README first paragraph when package description is absent', () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# demo\n\nThis library renders interactive charts for dashboards.\n');
    const analysis = new XRayBusinessAnalyzer().analyze(makeContext(root));
    expect(analysis.profile.purpose).toContain('interactive charts');
  });

  it('exposes scan() and exportReport()', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', description: 'thing' }));
    const analyzer = new XRayBusinessAnalyzer();
    expect(Array.isArray(await analyzer.scan(makeContext(root)))).toBe(true);
    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Business Intelligence Report');
    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
