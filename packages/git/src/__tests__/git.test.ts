import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { XRayGitAnalyzer } from '../git-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'git-fixture');

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

function gitInit(dir: string): void {
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'ignore' });
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test User"');
  run('git config commit.gpgsign false');
}

describe('XRayGitAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports not-a-repo for a plain directory', () => {
    // Use an isolated temp dir: the test fixture under the repo would resolve to
    // the surrounding repo-xray git tree and report as a repository.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-git-none-'));
    try {
      const analysis = new XRayGitAnalyzer().analyze(makeContext(isolated));
      expect(analysis.stats.isRepo).toBe(false);
      expect(analysis.report).toContain('not a git repository');
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('collects commit and contributor stats and flags a single-author bus factor', () => {
    gitInit(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    execSync('git add . && git commit -m "first"', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'b.txt'), 'two');
    execSync('git add . && git commit -m "second"', { cwd: root, stdio: 'ignore' });

    const analysis = new XRayGitAnalyzer().analyze(makeContext(root));
    expect(analysis.stats.isRepo).toBe(true);
    expect(analysis.stats.totalCommits).toBe(2);
    expect(analysis.stats.contributors).toBe(1);
    expect(analysis.findings.map((f) => f.title)).toContain('Single-Contributor Bus Factor');
    expect(analysis.stats.hotspots.length).toBeGreaterThan(0);
  });

  it('exposes scan() and exportReport()', async () => {
    gitInit(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    execSync('git add . && git commit -m "first"', { cwd: root, stdio: 'ignore' });

    const analyzer = new XRayGitAnalyzer();
    expect(Array.isArray(await analyzer.scan(makeContext(root)))).toBe(true);
    const md = await analyzer.exportReport(makeContext(root), 'markdown');
    expect(md).toContain('Git Intelligence Report');
    const json = await analyzer.exportReport(makeContext(root), 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
