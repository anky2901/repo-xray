import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRayPipeline, PipelineInput } from '../pipeline';
import { FileCache } from '@repo-xray/cache';
import { XRayConfig, Logger } from '@repo-xray/shared';
import { Finding } from '@repo-xray/types';

const testDir = path.join(__dirname, 'test-pipeline-fixtures');
const cacheDir = path.join(testDir, '.xray-cache');
const outputDir = path.join(testDir, '.xray-reports');

describe('Pipeline', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  const mockConfig: XRayConfig = {
    telemetry: false,
    ai: { enabled: false, provider: null },
    github: { authMode: 'public' },
    scan: { maxMemoryMb: 512, timeoutMs: 60000, maxRepoSizeGb: 2, parallel: true },
    ignore: { useGitignore: true, patterns: [] },
    cache: { enabled: true, dir: cacheDir, ttlHours: 24 },
    output: { dir: outputDir, formats: ['json'] },
  };

  test('same input -> identical output (determinism)', async () => {
    fs.writeFileSync(path.join(testDir, 'index.js'), 'const a = "sk-1234567890abcdef1234567890abcdef1234567890abcdef";');
    
    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();

    const input: PipelineInput = {
      source: testDir,
      mode: 'quick',
      modules: ['security', 'architecture'],
      config: mockConfig,
      cache,
      logger: mockLogger,
    };

    const res1 = await pipeline.run(input);
    const res2 = await pipeline.run(input);

    expect(res1.findings.length).toBe(res2.findings.length);
    expect(res1.scores).toEqual(res2.scores);
    // Ignore runtime timestamps for exact equal check
    expect(res1.findings[0]?.id).toBe(res2.findings[0]?.id);
  });

  test('handles empty repo', async () => {
    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();

    const input: PipelineInput = {
      source: testDir,
      mode: 'quick',
      modules: ['security', 'architecture'],
      config: mockConfig,
      cache,
      logger: mockLogger,
    };

    const res = await pipeline.run(input);
    expect(res.findings.length).toBe(0);
    expect(res.scores.overall).toBe(100);
  });

  test('handles binary-only repo', async () => {
    fs.writeFileSync(path.join(testDir, 'bin.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]));
    
    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();

    const input: PipelineInput = {
      source: testDir,
      mode: 'quick',
      modules: ['security', 'architecture'],
      config: mockConfig,
      cache,
      logger: mockLogger,
    };

    const res = await pipeline.run(input);
    expect(res.findings.length).toBe(0);
    expect(res.scores.overall).toBe(100);
  });

  test('throws error if local path does not exist', async () => {
    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();
    const input: PipelineInput = {
      source: path.join(testDir, 'non-existent-dir-12345'),
      mode: 'quick',
      modules: ['security'],
      config: mockConfig,
      cache,
      logger: mockLogger,
    };
    await expect(pipeline.run(input)).rejects.toThrow('Local path does not exist');
  });

  test('walks subdirectories recursively', async () => {
    const subDir = path.join(testDir, 'src', 'controllers');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'user.js'), 'console.log("hello");');

    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();
    const input: PipelineInput = {
      source: testDir,
      mode: 'quick',
      modules: ['security'],
      config: mockConfig,
      cache,
      logger: mockLogger,
    };
    const res = await pipeline.run(input);
    expect(res.meta.totalFiles).toBeGreaterThanOrEqual(1);
  });

  test('scoring logic deductions for all severities', async () => {
    const cache = new FileCache(cacheDir);
    const pipeline = new XRayPipeline();
    
    const { XRaySecurityAnalyzer } = await import('@repo-xray/security');
    const originalScan = XRaySecurityAnalyzer.prototype.scan;
    
    XRaySecurityAnalyzer.prototype.scan = async () => {
      return [
        { id: 'sec-1', module: 'security', title: 'Critical Finding', severity: 'CRITICAL', confidence: 100, evidence: [] },
        { id: 'sec-2', module: 'security', title: 'High Finding', severity: 'HIGH', confidence: 100, evidence: [] },
        { id: 'sec-3', module: 'security', title: 'Medium Finding', severity: 'MEDIUM', confidence: 100, evidence: [] },
        { id: 'sec-4', module: 'security', title: 'Low Finding', severity: 'LOW', confidence: 100, evidence: [] },
      ] as unknown as Finding[];
    };

    try {
      const input: PipelineInput = {
        source: testDir,
        mode: 'quick',
        modules: ['security'],
        config: mockConfig,
        cache,
        logger: mockLogger,
      };
      
      const res = await pipeline.run(input);
      expect(res.scores.security).toBe(53);
    } finally {
      XRaySecurityAnalyzer.prototype.scan = originalScan;
    }
  });
});
