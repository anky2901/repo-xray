import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import { buildIgnoreFilter } from '../ignore';
import { XRayConfig } from '../config';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('Ignore Filter', () => {
  const mockConfig: XRayConfig = {
    telemetry: false,
    ai: { enabled: false, provider: null },
    github: { authMode: 'public' },
    scan: { maxMemoryMb: 512, timeoutMs: 60000, maxRepoSizeGb: 2, parallel: true },
    ignore: { useGitignore: true, patterns: [] },
    cache: { enabled: true, dir: '.xray-cache', ttlHours: 24 },
    output: { dir: '.xray-reports', formats: ['json'] },
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should ignore default patterns (node_modules, .git, etc.)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const filter = buildIgnoreFilter('/mock/workspace', mockConfig);

    expect(filter('/mock/workspace/node_modules/dep/index.js')).toBe(true);
    expect(filter('/mock/workspace/.git/config')).toBe(true);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should parse and respect .gitignore', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => typeof p === 'string' && p.endsWith('.gitignore'));
    vi.mocked(fs.readFileSync).mockReturnValue('*.log\n# comment\nsecret_dir/\n');

    const filter = buildIgnoreFilter('/mock/workspace', mockConfig);

    expect(filter('/mock/workspace/debug.log')).toBe(true);
    expect(filter('/mock/workspace/secret_dir/data.txt')).toBe(true);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should gracefully handle read errors for .gitignore', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => typeof p === 'string' && p.endsWith('.gitignore'));
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const filter = buildIgnoreFilter('/mock/workspace', mockConfig);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should parse and respect .xrayignore', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => typeof p === 'string' && p.endsWith('.xrayignore'));
    vi.mocked(fs.readFileSync).mockReturnValue('*.tmp\n');

    const filter = buildIgnoreFilter('/mock/workspace', mockConfig);

    expect(filter('/mock/workspace/temp.tmp')).toBe(true);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should gracefully handle read errors for .xrayignore', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => typeof p === 'string' && p.endsWith('.xrayignore'));
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const filter = buildIgnoreFilter('/mock/workspace', mockConfig);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should support custom ignore patterns from config', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const customConfig = {
      ...mockConfig,
      ignore: {
        useGitignore: false,
        patterns: ['custom-file.ts', 'logs/**/*.txt', 'build-*']
      }
    };

    const filter = buildIgnoreFilter('/mock/workspace', customConfig);

    expect(filter('/mock/workspace/custom-file.ts')).toBe(true);
    expect(filter('/mock/workspace/logs/sub/debug.txt')).toBe(true);
    expect(filter('/mock/workspace/build-output')).toBe(true);
    expect(filter('/mock/workspace/src/index.ts')).toBe(false);
  });

  it('should match direct name exact matches', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const customConfig = {
      ...mockConfig,
      ignore: {
        useGitignore: false,
        patterns: ['test-exact']
      }
    };
    const filter = buildIgnoreFilter('/mock/workspace', customConfig);
    expect(filter('/mock/workspace/test-exact')).toBe(true);
    expect(filter('/mock/workspace/subdir/test-exact')).toBe(true);
  });
});
