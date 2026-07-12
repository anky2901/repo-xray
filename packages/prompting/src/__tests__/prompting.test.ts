import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayPromptGenerator } from '../prompt-generator';
import type { ScanResult, Finding } from '@repo-xray/types';

const root = path.join(__dirname, 'prompt-fixture');

function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    schema: '1.0',
    scanId: 'scan',
    repoId: 'repo',
    mode: 'deep',
    findings: [],
    scores: { overall: 100, security: 100, architecture: 100, maintainability: 100, testCoverage: 100, releaseReadiness: 100, dependency: 100 },
    meta: {
      name: 'demo-app',
      source: 'local',
      languages: { TypeScript: 80, CSS: 20 },
      frameworks: ['Express'],
      packageManagers: ['npm'],
      totalFiles: 10,
      totalLines: 500,
      entrypoints: ['src/server.ts'],
      architectureStyle: 'Standard layout',
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
    ...overrides,
  };
}

describe('XRayPromptGenerator', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('produces the five prompt files', () => {
    const bundle = new XRayPromptGenerator().generate(root, makeResult());
    expect(Object.keys(bundle.files).sort()).toEqual([
      'PROMPTS/audit.md',
      'PROMPTS/bugfix.md',
      'PROMPTS/dev.md',
      'PROMPTS/feature.md',
      'PROMPTS/onboarding.md',
    ]);
  });

  it('uses extracted facts, not hallucinated ones', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const bundle = new XRayPromptGenerator().generate(root, makeResult());
    expect(bundle.facts.stack).toContain('Express');
    expect(bundle.facts.stack).not.toContain('React');
    expect(bundle.facts.entrypoint).toBe('src/server.ts');
    expect(bundle.facts.testCommand).toBe('npm test');
    expect(bundle.files['PROMPTS/dev.md']).toContain('demo-app');
    expect(bundle.files['PROMPTS/onboarding.md']).toContain('src/server.ts');
  });

  it('lists scan findings as known issues in dev and audit prompts', () => {
    const finding: Finding = {
      id: 'sec-1',
      module: 'security',
      title: 'Hardcoded OpenAI API Key',
      summary: 'leak',
      severity: 'CRITICAL',
      confidence: 96,
      evidence: [{ file: 'src/config.ts', line: 3 }],
      reasoning: 'A secret pattern was found.',
      reproducible: true,
      tags: ['secret'],
    };
    const bundle = new XRayPromptGenerator().generate(root, makeResult({ findings: [finding] }));
    expect(bundle.files['PROMPTS/dev.md']).toContain('Hardcoded OpenAI API Key');
    expect(bundle.files['PROMPTS/audit.md']).toContain('src/config.ts');
  });

  it('derives a python test command when no package.json test script exists', () => {
    const bundle = new XRayPromptGenerator().generate(
      root,
      makeResult({ meta: { ...makeResult().meta, frameworks: ['FastAPI'], languages: { Python: 100 }, packageManagers: ['pip'] } })
    );
    expect(bundle.facts.testCommand).toBe('pytest');
    expect(bundle.facts.namingConvention).toContain('snake_case');
  });
});
