import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayCiAnalyzer } from '../ci-analyzer';
import type { ScanContext } from '@repo-xray/types';

const root = path.join(__dirname, 'ci-fixture');

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

function writeWorkflow(name: string, content: string): void {
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

describe('XRayCiAnalyzer', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports no findings for a clean, pinned workflow that runs tests', () => {
    writeWorkflow(
      'ci.yml',
      [
        'name: CI',
        'on: [push]',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 10',
        '    steps:',
        '      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3',
        '      - run: pnpm test',
      ].join('\n')
    );
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    expect(analysis.providers).toContain('github-actions');
    expect(analysis.testsConfigured).toBe(true);
    expect(analysis.findings).toHaveLength(0);
  });

  it('flags unpinned actions, write-all permissions, and missing timeout', () => {
    writeWorkflow(
      'ci.yml',
      [
        'name: CI',
        'on: [push]',
        'permissions: write-all',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v3',
        '      - run: npm test',
      ].join('\n')
    );
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    const titles = analysis.findings.map((f) => f.title);
    expect(titles).toContain('Unpinned GitHub Action');
    expect(titles).toContain('Overly Permissive Workflow Permissions');
    expect(titles).toContain('Workflow Job Missing Timeout');
  });

  it('flags a hardcoded secret literal but not a secrets reference', () => {
    writeWorkflow(
      'secret.yml',
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 5',
        '    env:',
        '      API_KEY: "hardcoded-supersecret-value-123"',
        '      SAFE_TOKEN: ${{ secrets.TOKEN }}',
        '    steps:',
        '      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3',
        '      - run: go test ./...',
      ].join('\n')
    );
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    const secretFindings = analysis.findings.filter((f) => f.title === 'Hardcoded Secret in Workflow');
    expect(secretFindings).toHaveLength(1);
    // The masked snippet must not contain the literal value.
    expect(secretFindings[0].evidence[0].snippet).not.toContain('supersecret');
  });

  it('flags missing tests when CI runs but has no test step', () => {
    writeWorkflow(
      'lint.yml',
      [
        'name: Lint',
        'on: [push]',
        'jobs:',
        '  lint:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 5',
        '    steps:',
        '      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3',
        '      - run: eslint .',
      ].join('\n')
    );
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    expect(analysis.testsConfigured).toBe(false);
    expect(analysis.findings.map((f) => f.title)).toContain('CI Does Not Run Tests');
  });

  it('handles malformed YAML without crashing', () => {
    writeWorkflow('bad.yml', 'invalid: yaml: [unclosed');
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    expect(analysis.findings.map((f) => f.title)).toContain('Malformed Workflow YAML');
  });

  it('reports no providers for a repo without CI config', () => {
    const analysis = new XRayCiAnalyzer().analyze(makeContext(root));
    expect(analysis.providers).toHaveLength(0);
    expect(analysis.workflows).toHaveLength(0);
    expect(analysis.report).toContain('No CI configuration detected');
  });
});
