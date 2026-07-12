import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { loadConfig, XRayConfig } from '../config';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('Config loading precedence', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load default configuration', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config = loadConfig({});
    expect(config.telemetry).toBe(false);
    expect(config.cache.enabled).toBe(true);
    expect(config.scan.timeoutMs).toBe(60000);
  });

  it('should merge config from .xrayrc', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => typeof p === 'string' && (p.endsWith('.xrayrc') || p.endsWith('.xrayrc.json')));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      scan: { timeoutMs: 120000 },
      ignore: { patterns: ['dist'] }
    }));

    const config = loadConfig({});
    expect(config.scan.timeoutMs).toBe(120000);
    expect(config.scan.maxMemoryMb).toBe(512);
    expect(config.ignore.patterns).toEqual(['dist']);
  });

  it('should override with environment variables', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const env = {
      XRAY_SCAN_TIMEOUT_MS: '15000',
      XRAY_CACHE_ENABLED: 'false',
      XRAY_CACHE_DIR: '.custom-cache',
      XRAY_CACHE_TTL_HOURS: '48',
      XRAY_OUTPUT_DIR: '.custom-reports',
      XRAY_SCAN_PARALLEL: 'false',
      XRAY_IGNORE_USE_GITIGNORE: 'false',
      XRAY_IGNORE_PATTERNS: 'a, b'
    };

    const config = loadConfig(env);
    expect(config.scan.timeoutMs).toBe(15000);
    expect(config.cache.enabled).toBe(false);
    expect(config.cache.dir).toBe('.custom-cache');
    expect(config.cache.ttlHours).toBe(48);
    expect(config.output.dir).toBe('.custom-reports');
    expect(config.scan.parallel).toBe(false);
    expect(config.ignore.useGitignore).toBe(false);
    expect(config.ignore.patterns).toEqual(['a', 'b']);
  });

  it('should apply CLI overrides last', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const env = { XRAY_SCAN_TIMEOUT_MS: '15000' };
    const overrides = { scan: { timeoutMs: 5000 } };

    const config = loadConfig(env, overrides as unknown as Partial<XRayConfig>);
    expect(config.scan.timeoutMs).toBe(5000);
  });

  it('should merge objects, replace arrays, replace primitives', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => typeof p === 'string' && (p.endsWith('.xrayrc') || p.endsWith('.xrayrc.json')));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      scan: { timeoutMs: 120000, parallel: false },
      ignore: { patterns: ['file1'] }
    }));

    const env = {
      XRAY_SCAN_MAX_MEMORY_MB: '1024',
      XRAY_IGNORE_PATTERNS: 'file2'
    };

    const config = loadConfig(env);
    expect(config.scan.timeoutMs).toBe(120000);
    expect(config.scan.parallel).toBe(false);
    expect(config.scan.maxMemoryMb).toBe(1024);
    expect(config.ignore.patterns).toEqual(['file2']);
  });

  it('should parse XRAY_OUTPUT_FORMATS env variable correctly', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const env = {
      XRAY_OUTPUT_FORMATS: 'json, html, sarif'
    };
    const config = loadConfig(env);
    expect(config.output.formats).toEqual(['json', 'html', 'sarif']);
  });

  it('should throw an error on validation failure', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const env = {
      XRAY_SCAN_TIMEOUT_MS: 'not-a-number'
    };
    expect(() => loadConfig(env)).toThrow(/Config validation failed/);
  });
});
