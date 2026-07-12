import { describe, test, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayArchitectureAnalyzer } from '../architecture-analyzer';
import { ScanContext, SimpleLogger, CacheStore } from '@repo-xray/types';

const testDir = path.join(__dirname, 'test-arch-fixtures');

describe('M2 Architecture', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  const mockLogger: SimpleLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const mockConfig = {
    telemetry: false,
    ai: { enabled: false, provider: null },
    github: { authMode: 'public' },
    scan: { maxMemoryMb: 512, timeoutMs: 60000, maxRepoSizeGb: 2, parallel: true },
    ignore: { useGitignore: true, patterns: [] },
    cache: { enabled: false, dir: '.xray-cache', ttlHours: 24 },
    output: { dir: testDir, formats: ['json'] },
  };

  const mockContext: ScanContext = {
    workspacePath: testDir,
    repoMeta: {
      name: 'test',
      source: 'local',
      languages: {},
      frameworks: [],
      packageManagers: [],
      totalFiles: 0,
      totalLines: 0,
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
    config: mockConfig,
    cache: null as unknown as CacheStore,
    logger: mockLogger,
    mode: 'quick',
  };

  test('detects cyclic dependency', async () => {
    // Create a circular dependency cycle: a.js -> b.js -> c.js -> a.js
    fs.writeFileSync(path.join(testDir, 'a.js'), 'import "./b.js";');
    fs.writeFileSync(path.join(testDir, 'b.js'), 'import "./c.js";');
    fs.writeFileSync(path.join(testDir, 'c.js'), 'import "./a.js";');

    const analyzer = new XRayArchitectureAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const cycle = findings.find(f => f.title === 'Circular Dependency Detected');
    expect(cycle).toBeDefined();
    expect(cycle?.severity).toBe('HIGH');
  });

  test('detects god file and dead module', async () => {
    // Write a god file (lines > 500, exports > 15, and imported by > 20 files)
    const godContent = Array(510).fill('// comment').join('\n') + '\n' +
      Array(20).fill(0).map((_, idx) => `export const x${idx} = ${idx};`).join('\n');
    fs.writeFileSync(path.join(testDir, 'god.js'), godContent);

    // Create 21 importing files
    for (let i = 1; i <= 21; i++) {
      fs.writeFileSync(path.join(testDir, `imp${i}.js`), 'import "./god.js";');
    }

    const analyzer = new XRayArchitectureAnalyzer();
    const findings = await analyzer.scan(mockContext);
    
    const godFile = findings.find(f => f.title === 'God File (Anti-Pattern)');
    expect(godFile).toBeDefined();

    // Dead modules candidates (imp1.js to imp21.js are not imported by any other files)
    const deadModule = findings.find(f => f.title === 'Dead Module Candidate');
    expect(deadModule).toBeDefined();
  });

  test('generates valid HTML dependency graph', async () => {
    fs.writeFileSync(path.join(testDir, 'index.js'), 'import "./utils.js";');
    fs.writeFileSync(path.join(testDir, 'utils.js'), 'export const foo = 1;');

    const analyzer = new XRayArchitectureAnalyzer();
    await analyzer.scan(mockContext);

    const htmlFile = path.join(testDir, 'ARCHITECTURE.html');
    expect(fs.existsSync(htmlFile)).toBe(true);
    const content = fs.readFileSync(htmlFile, 'utf-8');
    expect(content).toContain('Interactive Dependency Graph');
    expect(content).toContain('2000/svg');
    expect(content).toContain('index.js');
  });
});
