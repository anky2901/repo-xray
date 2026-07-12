import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ScanStore } from '@repo-xray/sdk';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'pnpm -v') return Buffer.from('9.0.0');
    if (cmd === 'git --version') return Buffer.from('git version 2.40.0');
    if (cmd === 'where git') return Buffer.from('C:\\Program Files\\Git\\cmd\\git.exe');
    if (cmd.includes('Get-PSDrive')) return Buffer.from(JSON.stringify({ Free: 1024 * 1024 * 1024 * 5 }));
    return Buffer.from('');
  })
}));

vi.mock('https', () => {
  return {
    request: vi.fn().mockImplementation((options, callback) => {
      const mockResponse = {
        on: vi.fn().mockImplementation((event, handler) => {
          if (event === 'data') {
            handler(Buffer.from(JSON.stringify({ vulns: [] })));
          }
          if (event === 'end') {
            handler();
          }
        })
      };
      if (callback) {
        callback(mockResponse);
      }
      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };
    })
  };
});

describe('CLI Doctor command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const reportDir = path.join(process.cwd(), '.xray-reports');
  const dbPath = path.join(reportDir, 'xray.db');

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await fs.promises.rm(reportDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(reportDir, { recursive: true, force: true });
  });

  it('should run doctor checks successfully if all systems healthy', async () => {
    const { program } = await import('../src/index');
    await program.parseAsync(['node', 'xray', 'doctor']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Running doctor checks...'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('node:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pnpm: 9.0.0 (OK)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sqlite (better-sqlite3): OK'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('git installed: YES'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Doctor check passed.'));
  });

  it('should scan a local workspace and persist an empty result', async () => {
    const fixtureDir = path.join(process.cwd(), 'apps', 'cli');
    const { program } = await import('../src/index');
    await program.parseAsync(['node', 'xray', 'scan', fixtureDir]);

    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(output.meta.source).toBe('local');
    expect(output.findings).toEqual([]);
    expect(output.meta.runtime).toBeUndefined();
    expect(fs.existsSync(dbPath)).toBe(true);

    const store = new ScanStore(dbPath);
    try {
      const saved = store.getScan(output.scanId);
      expect(saved?.repoId).toBe(output.repoId);
      expect(saved?.meta.runtime.startedAt).toBeDefined();
    } finally {
      store.close();
    }
  }, 30000);

  it('should produce the same deterministic scan artifact for the same input twice', async () => {
    const fixtureDir = path.join(process.cwd(), 'apps', 'cli');
    const { program } = await import('../src/index');

    await program.parseAsync(['node', 'xray', 'scan', fixtureDir]);
    const first = logSpy.mock.calls.at(-1)?.[0] as string;

    await program.parseAsync(['node', 'xray', 'scan', fixtureDir]);
    const second = logSpy.mock.calls.at(-1)?.[0] as string;

    const hash1 = crypto.createHash('sha256').update(first).digest('hex');
    const hash2 = crypto.createHash('sha256').update(second).digest('hex');

    expect(hash1).toBe(hash2);
  }, 30000);

  it('should list scan history for a repo and compare two saved scans', async () => {
    const store = new ScanStore(dbPath);
    try {
      store.saveScan({
        schema: '1.0',
        scanId: 'scan-1',
        repoId: 'repo-1',
        mode: 'quick',
        findings: [],
        scores: { overall: 0, security: 0, architecture: 0, maintainability: 0, testCoverage: 0, releaseReadiness: 0, dependency: 0 },
        meta: { name: 'repo', source: 'local', languages: {}, frameworks: [], packageManagers: ['pnpm'], totalFiles: 1, totalLines: 1, runtime: { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.000Z', durationMs: 0 } },
      });
      store.saveScan({
        schema: '1.0',
        scanId: 'scan-2',
        repoId: 'repo-1',
        mode: 'quick',
        findings: [
          { id: 'finding-a', module: 'security', title: 'A', summary: '', severity: 'HIGH', confidence: 90, evidence: [], reasoning: '', reproducible: true, tags: [] },
        ],
        scores: { overall: 10, security: 10, architecture: 0, maintainability: 0, testCoverage: 0, releaseReadiness: 0, dependency: 0 },
        meta: { name: 'repo', source: 'local', languages: {}, frameworks: [], packageManagers: ['pnpm'], totalFiles: 1, totalLines: 1, runtime: { startedAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T00:00:00.000Z', durationMs: 0 } },
      });
    } finally {
      store.close();
    }

    const { program } = await import('../src/index');
    await program.parseAsync(['node', 'xray', 'history', 'repo-1']);
    const history = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe('scan-2');

    await program.parseAsync(['node', 'xray', 'compare', 'scan-1', 'scan-2']);
    const diff = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(diff.addedFindings).toHaveLength(1);
    expect(diff.addedFindings[0].id).toBe('finding-a');
  });

  it('should fail compare when a scan is missing', async () => {
    const { program } = await import('../src/index');
    await program.parseAsync(['node', 'xray', 'compare', 'missing-a', 'missing-b']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Scan not found'));
  });

  it('should generate prompt files from a local workspace', async () => {
    const fixtureDir = path.join(process.cwd(), 'apps', 'cli');
    const { program } = await import('../src/index');
    await program.parseAsync(['node', 'xray', 'prompts', fixtureDir]);

    const summaryCall = logSpy.mock.calls
      .map((c) => c[0] as string)
      .reverse()
      .find((line) => typeof line === 'string' && line.includes('"files"'));
    expect(summaryCall).toBeDefined();
    const output = JSON.parse(summaryCall as string);
    expect(output.files).toContain('PROMPTS/dev.md');
    expect(output.files).toContain('PROMPTS/onboarding.md');
    expect(fs.existsSync(path.join(reportDir, 'PROMPTS', 'dev.md'))).toBe(true);
  }, 30000);
});
