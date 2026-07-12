import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayDependencyAnalyzer, parseManifests, detectDuplicates } from '../dependency-analyzer';
import type { ScanContext, Finding } from '@repo-xray/types';

const root = path.join(__dirname, 'dep-fixture');

function makeContext(workspacePath: string, priorFindings: Finding[] = []): ScanContext {
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
    offline: true,
    priorFindings,
  };
}

describe('dependency parsing', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses npm and pypi manifests deterministically', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { moment: '^2.29.0', left: '1.0.0' }, devDependencies: { vitest: '^1.0.0' } })
    );
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'fastapi>=0.100.0\n# comment\nrequests==2.31.0\n');

    const deps = parseManifests(root);
    const names = deps.map((d) => d.name);
    expect(names).toContain('moment');
    expect(names).toContain('vitest');
    expect(names).toContain('fastapi');
    expect(names).toContain('requests');
    // Stable ordering: npm before pypi, alphabetical within ecosystem.
    const second = parseManifests(root);
    expect(deps).toEqual(second);
  });

  it('flags heavyweight dependencies with known alternatives', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { moment: '^2.29.0' } }));
    const analysis = await new XRayDependencyAnalyzer().analyze(makeContext(root));
    const oversized = analysis.findings.find((f) => f.tags.includes('bundle-size'));
    expect(oversized).toBeDefined();
    expect(oversized?.title).toContain('moment');
    expect(oversized?.reasoning.toLowerCase()).toContain('dayjs');
  });

  it('detects duplicate dependencies from package-lock.json', () => {
    const lock = {
      packages: {
        '': { name: 'root' },
        'node_modules/ms': { version: '2.1.3' },
        'node_modules/debug/node_modules/ms': { version: '2.0.0' },
      },
    };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    const dups = detectDuplicates(root);
    const ms = dups.find((d) => d.name === 'ms');
    expect(ms).toBeDefined();
    expect(ms?.versions).toEqual(['2.0.0', '2.1.3']);
  });

  it('surfaces CVE count from prior security findings without re-querying network', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { lodash: '4.17.0' } }));
    const cve: Finding = {
      id: 'sec-cve-lodash-GHSA-x',
      module: 'security',
      title: 'Vulnerable Dependency: lodash',
      summary: 'lodash@4.17.0 has a known issue',
      severity: 'HIGH',
      confidence: 95,
      evidence: [{ file: 'package.json' }],
      reasoning: 'Prototype pollution vulnerability in lodash below 4.17.21.',
      reproducible: true,
      tags: ['supply-chain', 'cve'],
    };
    const analysis = await new XRayDependencyAnalyzer().analyze(makeContext(root, [cve]));
    expect(analysis.vulnerableCount).toBe(1);
    expect(analysis.report).toContain('Vulnerable Dependencies (1)');
    expect(analysis.score).toBeLessThan(100);
  });

  it('returns a clean report for a repo with no dependency issues', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { left: '1.0.0' } }));
    const analysis = await new XRayDependencyAnalyzer().analyze(makeContext(root));
    expect(analysis.findings).toHaveLength(0);
    expect(analysis.score).toBe(100);
  });

  it('detects copyleft license conflict against a permissive project', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ license: 'MIT', dependencies: { gpllib: '1.0.0' } }));
    const nm = path.join(root, 'node_modules', 'gpllib');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: 'gpllib', version: '1.0.0', license: 'GPL-3.0' }));

    const analysis = await new XRayDependencyAnalyzer().analyze(makeContext(root));
    const license = analysis.findings.find((f) => f.tags.includes('license'));
    expect(license).toBeDefined();
    expect(license?.title).toContain('gpllib');
  });

  it('parses pyproject.toml dependencies', () => {
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      ['[project]', 'name = "x"', 'dependencies = [', '  "fastapi>=0.100.0",', '  "pydantic>=2.0",', ']'].join('\n')
    );
    const deps = parseManifests(root);
    const names = deps.map((d) => d.name);
    expect(names).toContain('fastapi');
    expect(names).toContain('pydantic');
    expect(deps.every((d) => d.ecosystem === 'pypi')).toBe(true);
  });

  it('detects duplicates from pnpm-lock.yaml', () => {
    const lock = [
      'lockfileVersion: "6.0"',
      'packages:',
      '  /ms@2.1.3:',
      '    resolution: {integrity: sha512-aaa}',
      '  /ms@2.0.0:',
      '    resolution: {integrity: sha512-bbb}',
      '  /debug@4.3.4:',
      '    resolution: {integrity: sha512-ccc}',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), lock);
    const dups = detectDuplicates(root);
    const ms = dups.find((d) => d.name === 'ms');
    expect(ms?.versions).toEqual(['2.0.0', '2.1.3']);
  });

  it('flags abandoned dependencies using cached npm metadata (no network)', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { stalelib: '1.0.0' } }));
    // Pre-seed the npm-meta cache with an old publish date so the network path is skipped.
    const metaDir = path.join(root, '.xray-cache', 'npm-meta');
    fs.mkdirSync(metaDir, { recursive: true });
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(metaDir, 'stalelib.json'), JSON.stringify({ lastPublish: threeYearsAgo }));

    const ctx = makeContext(root);
    ctx.offline = false;
    const analysis = await new XRayDependencyAnalyzer().analyze(ctx);
    const abandoned = analysis.findings.find((f) => f.tags.includes('abandoned'));
    expect(abandoned).toBeDefined();
    expect(abandoned?.title).toContain('stalelib');
  });

  it('detects duplicates from a v1 (nested) package-lock.json', () => {
    const lock = {
      dependencies: {
        ms: { version: '2.1.3' },
        debug: { version: '4.3.4', dependencies: { ms: { version: '2.0.0' } } },
      },
    };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    const dups = detectDuplicates(root);
    expect(dups.find((d) => d.name === 'ms')?.versions).toEqual(['2.0.0', '2.1.3']);
  });

  it('exposes scan() and exportReport() and renders all report sections', async () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ license: 'MIT', dependencies: { moment: '^2.29.0', gpllib: '1.0.0' } })
    );
    const nm = path.join(root, 'node_modules', 'gpllib');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: 'gpllib', version: '1.0.0', license: 'GPL-3.0' }));
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/ms': { version: '2.1.3' }, 'node_modules/a/node_modules/ms': { version: '2.0.0' } } })
    );

    const analyzer = new XRayDependencyAnalyzer();
    const findings = await analyzer.scan(makeContext(root));
    expect(findings.length).toBeGreaterThan(0);

    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Heavyweight Dependencies');
    expect(md).toContain('Duplicate Dependencies');
    expect(md).toContain('License Conflicts');

    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
