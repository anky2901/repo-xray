import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  Pipeline, PipelineInput, PipelineContext, PipelineStage,
  LocalProvider, stableJson, stableArtifactJson, sortFindings, FeatureDisabledError, UnsupportedPhaseError, assertPhaseACommandAllowed, GitHubProvider
} from '../index';
import { ScanResult, CacheStore } from '@repo-xray/types';
import { XRayConfig, Logger } from '@repo-xray/shared';

const fixtureRoot = path.join(__dirname, 'local-provider-fixture');

describe('Pipeline contracts', () => {
  beforeEach(async () => {
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    await fs.promises.mkdir(fixtureRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('should allow implementing Pipeline interface', async () => {
    class MockPipeline implements Pipeline {
      async run(input: PipelineInput): Promise<ScanResult> {
        return {
          schema: '1.0',
          scanId: 'test-scan',
          repoId: 'test-repo',
          mode: input.mode,
          findings: [],
          scores: {
            overall: 100,
            security: 100,
            architecture: 100,
            maintainability: 100,
            testCoverage: 100,
            releaseReadiness: 100,
            dependency: 100,
          },
          meta: {
            name: 'test',
            source: 'local',
            languages: {},
            frameworks: [],
            packageManagers: [],
            totalFiles: 0,
            totalLines: 0,
            runtime: {
              startedAt: '2026-01-01T00:00:00.000Z',
              completedAt: '2026-01-01T00:00:00.000Z',
              durationMs: 0,
            },
          },
        };
      }
    }

    const pipeline = new MockPipeline();
    const result = await pipeline.run({
      source: 'abc',
      mode: 'quick',
      modules: ['security'],
      config: {} as unknown as XRayConfig,
      cache: null as unknown as CacheStore,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
    });

    expect(result.scanId).toBe('test-scan');
    expect(result.mode).toBe('quick');
  });

  it('should allow executing PipelineStage and accumulate findings', async () => {
    class DummyStage implements PipelineStage {
      name = 'dummy';
      async execute(ctx: PipelineContext): Promise<PipelineContext> {
        ctx.findings.push({
          id: 'f1',
          module: 'security',
          title: 'Dummy Finding',
          summary: 'A dummy finding',
          severity: 'INFO',
          confidence: 100,
          evidence: [],
          reasoning: 'Testing',
          reproducible: true,
          tags: [],
        });
        return ctx;
      }
    }

    const stage = new DummyStage();
    const initialContext: PipelineContext = {
      input: {
        source: 'dummy',
        mode: 'quick',
        modules: [],
        config: {} as unknown as XRayConfig,
        cache: null as unknown as CacheStore,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
      },
      findings: [],
    };

    const nextContext = await stage.execute(initialContext);
    expect(nextContext.findings.length).toBe(1);
    expect(nextContext.findings[0].id).toBe('f1');
  });

  it('LocalProvider should resolve a real local workspace path', async () => {
    const provider = new LocalProvider();
    const nested = path.join(fixtureRoot, '.', 'subdir', '..');
    const result = await provider.clone(nested, {});

    expect(result.path).toBe(path.resolve(fixtureRoot));
  });

  it('LocalProvider should derive metadata from package.json when present', async () => {
    const provider = new LocalProvider();
    await fs.promises.writeFile(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'fixture-package' }),
      'utf-8'
    );

    const meta = await provider.getMetadata(fixtureRoot);
    expect(meta).toEqual({
      name: 'fixture-package',
      source: 'local',
    });
  });

  it('LocalProvider should fall back on invalid package.json', async () => {
    const provider = new LocalProvider();
    await fs.promises.writeFile(
      path.join(fixtureRoot, 'package.json'),
      'invalid-json{',
      'utf-8'
    );

    const meta = await provider.getMetadata(fixtureRoot);
    expect(meta).toEqual({
      name: path.basename(fixtureRoot),
      source: 'local',
    });
  });

  it('LocalProvider should fall back to directory name without package.json', async () => {
    const provider = new LocalProvider();
    const meta = await provider.getMetadata(fixtureRoot);

    expect(meta).toEqual({
      name: path.basename(fixtureRoot),
      source: 'local',
    });
  });

  it('stableJson should sort object keys recursively', () => {
    const json = stableJson({ b: 1, a: { d: 2, c: 1 } });
    expect(json).toBe('{\n  "a": {\n    "c": 1,\n    "d": 2\n  },\n  "b": 1\n}');
  });

  it('stableArtifactJson should exclude runtime metadata from canonical output', () => {
    const artifact = stableArtifactJson({
      scanId: 'abc',
      meta: {
        runtime: {
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 1000,
        },
        source: 'local',
      },
    });
    expect(artifact).toBe('{\n  "meta": {\n    "source": "local"\n  },\n  "scanId": "abc"\n}');
  });

  it('sortFindings should produce stable ordering', () => {
    const findings = sortFindings([
      { id: '2', module: 'security', title: 'B', summary: '', severity: 'LOW', confidence: 1, evidence: [], reasoning: '', reproducible: true, tags: [] },
      { id: '1', module: 'architecture', title: 'A', summary: '', severity: 'HIGH', confidence: 1, evidence: [], reasoning: '', reproducible: true, tags: [] },
      { id: '3', module: 'security', title: 'A', summary: '', severity: 'HIGH', confidence: 1, evidence: [], reasoning: '', reproducible: true, tags: [] },
    ]);

    expect(findings.map((finding) => finding.id)).toEqual(['1', '3', '2']);
  });

  it('should expose explicit phase and feature errors', async () => {
    expect(() => assertPhaseACommandAllowed('release-check')).toThrow(UnsupportedPhaseError);

    const provider = new GitHubProvider();
    await expect(provider.clone('repo', {})).rejects.toBeInstanceOf(FeatureDisabledError);
    await expect(provider.getMetadata('repo')).rejects.toBeInstanceOf(FeatureDisabledError);
  });
});
