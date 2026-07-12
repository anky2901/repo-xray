import { describe, test, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { performDiscovery, detectEntrypoints, detectArchitectureStyle } from '../discovery';
import { XRayConfig } from '@repo-xray/shared';

const testDir = path.join(__dirname, 'test-disc-fixtures');

describe('M1 RepoUnderstanding', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  const mockConfig: XRayConfig = {
    telemetry: false,
    ai: { enabled: false, provider: null },
    github: { authMode: 'public' },
    scan: { maxMemoryMb: 512, timeoutMs: 60000, maxRepoSizeGb: 2, parallel: true },
    ignore: { useGitignore: true, patterns: [] },
    cache: { enabled: false, dir: '.xray-cache', ttlHours: 24 },
    output: { dir: '.xray-reports', formats: ['json'] },
  };

  test('detects TypeScript in TS-only repo', () => {
    fs.writeFileSync(path.join(testDir, 'index.ts'), 'const a = 1;');
    fs.writeFileSync(path.join(testDir, 'utils.ts'), 'export const b = 2;');

    const meta = performDiscovery(testDir, mockConfig);
    expect(meta.languages['TypeScript']).toBe(100);
    expect(meta.totalFiles).toBe(2);
  });

  test('detects Next.js and package managers from package.json', () => {
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          next: '^14.0.0',
          react: '^18.0.0',
        },
      })
    );
    fs.writeFileSync(path.join(testDir, 'pnpm-lock.yaml'), '');

    const meta = performDiscovery(testDir, mockConfig);
    expect(meta.frameworks).toContain('Next.js');
    expect(meta.frameworks).toContain('React');
    expect(meta.packageManagers).toContain('pnpm');
  });

  test('detects entrypoint from main field', () => {
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({
        main: 'dist/my-app.js',
      })
    );
    fs.mkdirSync(path.join(testDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'dist', 'my-app.js'), 'console.log("hello");');

    const entrypoints = detectEntrypoints(testDir, [
      path.join(testDir, 'package.json'),
      path.join(testDir, 'dist', 'my-app.js'),
    ]);
    expect(entrypoints).toContain(path.normalize('dist/my-app.js').replace(/\\/g, '/'));
  });

  test('handles repo with no package.json', () => {
    fs.writeFileSync(path.join(testDir, 'main.py'), 'print("hello")');
    const meta = performDiscovery(testDir, mockConfig);
    expect(meta.languages['Python']).toBe(100);
    expect(meta.frameworks.length).toBe(0);
  });

  test('handles monorepo structure', () => {
    fs.writeFileSync(path.join(testDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"');
    fs.mkdirSync(path.join(testDir, 'packages', 'a'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'packages', 'a', 'package.json'), '{}');
    fs.writeFileSync(path.join(testDir, 'package.json'), '{}');

    const style = detectArchitectureStyle(testDir, [
      path.join(testDir, 'package.json'),
      path.join(testDir, 'packages', 'a', 'package.json'),
    ]);
    expect(style).toBe('monorepo/workspace');
  });
});
