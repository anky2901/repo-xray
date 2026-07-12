import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayReleaseAnalyzer } from '../release-analyzer';
import { scoreReadme } from '../readme-score';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'release-fixture');

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
    mode: 'ci',
  };
}

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('XRayReleaseAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags missing license as a blocker and finding', () => {
    write('package.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
    const analysis = new XRayReleaseAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.map((f) => f.title)).toContain('Missing License');
    expect(analysis.blockers.some((b) => b.includes('LICENSE'))).toBe(true);
  });

  it('scores a complete project highly', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'great-lib',
        version: '1.2.3',
        description: 'A great library',
        main: 'index.js',
        license: 'MIT',
        repository: 'github:user/great-lib',
        keywords: ['x'],
        engines: { node: '>=18' },
        bugs: 'https://github.com/user/great-lib/issues',
        homepage: 'https://example.com',
      })
    );
    write('LICENSE', 'MIT License\n\nCopyright (c) 2026');
    write('README.md', '# great-lib\n\n## Installation\n\n```\nnpm install great-lib\n```\n\n## Usage\n\n```js\nrequire("great-lib")\n```\n\n## License\nMIT\n\n## Contributing\nPRs welcome\n\n![badge](https://img.shields.io/badge/x-y-green)');
    write('CHANGELOG.md', '# Changelog\n\n## 1.2.3');
    write('CONTRIBUTING.md', '# Contributing');
    write('examples/demo.js', 'console.log(1);');

    const analysis = new XRayReleaseAnalyzer().analyze(makeContext(root), true);
    expect(analysis.score).toBeGreaterThanOrEqual(90);
    expect(analysis.blockers).toHaveLength(0);
  });

  it('injects CI tests-configured state into the score', () => {
    write('package.json', JSON.stringify({ name: 'x', version: '1.0.0', description: 'd', main: 'i.js', license: 'MIT', repository: 'r' }));
    write('LICENSE', 'MIT License');

    const withCi = new XRayReleaseAnalyzer().analyze(makeContext(root), true);
    const withoutCi = new XRayReleaseAnalyzer().analyze(makeContext(root), false);
    expect(withCi.score).toBeGreaterThan(withoutCi.score);
    expect(withCi.report).toContain('CI status:');
  });

  it('flags invalid semver versions', () => {
    write('package.json', JSON.stringify({ name: 'x', version: 'not-a-version', license: 'MIT' }));
    write('LICENSE', 'MIT License');
    const analysis = new XRayReleaseAnalyzer().analyze(makeContext(root));
    const semverCheck = analysis.checks.find((c) => c.label.includes('semver'));
    expect(semverCheck?.earned).toBeLessThan(semverCheck!.points);
  });

  it('produces a repo-specific checklist', () => {
    write('package.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
    const analysis = new XRayReleaseAnalyzer().analyze(makeContext(root));
    expect(analysis.checklist).toContain('Release Checklist');
    expect(analysis.checklist).toContain('[ ]');
  });
});

describe('scoreReadme', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 0 for a missing README', () => {
    const score = scoreReadme(root);
    expect(score.present).toBe(false);
    expect(score.score).toBe(0);
  });

  it('is deterministic for the same input (single source of truth)', () => {
    write('README.md', '# x\n## Installation\nnpm install x\n## Usage\n```\nx()\n```\n## License\nMIT');
    const a = scoreReadme(root);
    const b = scoreReadme(root);
    expect(a.score).toBe(b.score);
    expect(a.score).toBeGreaterThanOrEqual(6);
  });
});
