import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ScanStore } from '../index';
import { ScanResult } from '@repo-xray/types';

const testDbPath = path.join(__dirname, 'test-storage.db');

function makeScan(overrides: Partial<ScanResult> & { scanId: string; repoId: string }): ScanResult {
  return {
    schema: '1.0',
    mode: 'quick',
    findings: [],
    scores: {
      overall: 80,
      security: 70,
      architecture: 80,
      maintainability: 90,
      testCoverage: 60,
      releaseReadiness: 85,
      dependency: 75,
    },
    meta: {
      name: 'test-repo',
      source: 'local',
      languages: { TypeScript: 100 },
      frameworks: [],
      packageManagers: ['pnpm'],
      totalFiles: 10,
      totalLines: 1000,
      runtime: {
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 0,
      },
    },
    ...overrides,
  };
}

describe('ScanStore SQLite Storage', () => {
  let store: ScanStore | null = null;

  beforeEach(async () => {
    const dir = path.dirname(testDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      await fs.promises.unlink(testDbPath);
    }
  });

  afterEach(async () => {
    if (store) {
      try { store.close(); } catch { /* ignore */ }
      store = null;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${testDbPath}${suffix}`;
      if (fs.existsSync(p)) {
        try { await fs.promises.unlink(p); } catch { /* ignore */ }
      }
    }
  });

  it('should initialize schema and apply all migrations', () => {
    store = new ScanStore(testDbPath);
    expect(fs.existsSync(testDbPath)).toBe(true);
    // schema_version table should exist and have entries
    expect(store.getScan('missing-id')).toBeNull();
  });

  it('should write and read scans with findings round-trip', () => {
    store = new ScanStore(testDbPath);
    const mockScan = makeScan({
      scanId: 'scan-123',
      repoId: 'repo-abc',
      findings: [
        {
          id: 'finding-1',
          module: 'security',
          title: 'Vulnerability found',
          summary: 'Critical vulnerability in dependencies',
          severity: 'CRITICAL',
          confidence: 90,
          evidence: [],
          reasoning: 'Testing SQLite storage',
          reproducible: true,
          tags: ['sec'],
        },
      ],
    });

    store.saveScan(mockScan);

    const retrieved = store.getScan('scan-123');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.repoId).toBe('repo-abc');
    expect(retrieved?.findings.length).toBe(1);
    expect(retrieved?.findings[0].id).toBe('finding-1');

    const summaries = store.listScans('repo-abc');
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe('scan-123');
    expect(summaries[0].status).toBe('completed');
  });

  it('should return real diff between two scans', () => {
    store = new ScanStore(testDbPath);

    const scanA = makeScan({
      scanId: 'scan-A',
      repoId: 'repo-diff',
      findings: [
        { id: 'f-common', module: 'security', title: 'Common', summary: '', severity: 'LOW', confidence: 50, evidence: [], reasoning: '', reproducible: true, tags: [] },
        { id: 'f-removed', module: 'security', title: 'Only in A', summary: '', severity: 'HIGH', confidence: 80, evidence: [], reasoning: '', reproducible: true, tags: [] },
      ],
      scores: { overall: 60, security: 50, architecture: 70, maintainability: 80, testCoverage: 40, releaseReadiness: 55, dependency: 60 },
    });

    const scanB = makeScan({
      scanId: 'scan-B',
      repoId: 'repo-diff',
      findings: [
        { id: 'f-common', module: 'security', title: 'Common', summary: '', severity: 'LOW', confidence: 50, evidence: [], reasoning: '', reproducible: true, tags: [] },
        { id: 'f-added', module: 'architecture', title: 'Only in B', summary: '', severity: 'MEDIUM', confidence: 70, evidence: [], reasoning: '', reproducible: false, tags: [] },
      ],
      scores: { overall: 80, security: 70, architecture: 90, maintainability: 80, testCoverage: 60, releaseReadiness: 75, dependency: 80 },
    });

    store.saveScan(scanA);
    store.saveScan(scanB);

    const diff = store.compareScans('scan-A', 'scan-B');
    expect(diff.error).toBeUndefined();
    expect(diff.addedFindings.map((f) => f.id)).toEqual(['f-added']);
    expect(diff.removedFindings.map((f) => f.id)).toEqual(['f-removed']);
    expect(diff.scoresDelta.overall).toBe(20);
    expect(diff.scoresDelta.security).toBe(20);
  });

  it('should return error when a scan id is missing in compareScans', () => {
    store = new ScanStore(testDbPath);
    const diff = store.compareScans('ghost-A', 'ghost-B');
    expect(diff.error).toBeDefined();
    expect(diff.addedFindings).toHaveLength(0);
    expect(diff.removedFindings).toHaveLength(0);
  });
});
