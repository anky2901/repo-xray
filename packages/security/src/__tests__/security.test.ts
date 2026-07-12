import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { XRaySecurityAnalyzer, redactSecret, shannonEntropy } from '../security-analyzer';
import { ScanContext, SimpleLogger, CacheStore } from '@repo-xray/types';

const testDir = path.join(__dirname, 'test-sec-fixtures');

describe('M3 Security', () => {
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
    output: { dir: '.xray-reports', formats: ['json'] },
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

  test('detects hardcoded AWS key', async () => {
    fs.writeFileSync(path.join(testDir, 'aws.js'), 'const key = "AKIA1234567890ABCDEF";');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const aws = findings.find(f => f.title === 'Hardcoded AWS API Key');
    expect(aws).toBeDefined();
    expect(aws?.severity).toBe('CRITICAL');
  });

  test('detects hardcoded GitHub PAT', async () => {
    fs.writeFileSync(path.join(testDir, 'git.js'), 'const pat = "ghp_1234567890abcdef1234567890abcdef1234";');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const git = findings.find(f => f.title === 'Hardcoded GitHub Personal Access Token');
    expect(git).toBeDefined();
    expect(git?.severity).toBe('CRITICAL');
  });

  test('detects high-entropy strings', () => {
    const highEntropy = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
    expect(shannonEntropy(highEntropy)).toBeGreaterThan(4.5);
  });

  test('masks secret values in output', () => {
    const raw = 'sk-1234567890abcdef1234567890abcdef1234567890abcdef';
    const masked = redactSecret(raw, 'OpenAI API Key');
    expect(masked).toBe('sk-[REDACTED]');
    expect(masked).not.toContain(raw.slice(3));
  });

  test('detects .env committed', async () => {
    fs.writeFileSync(path.join(testDir, '.env'), 'OPENAI_KEY=sk-abc');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const env = findings.find(f => f.title === 'Committed Environment File');
    expect(env).toBeDefined();
  });

  test('detects SQL injection pattern', async () => {
    fs.writeFileSync(path.join(testDir, 'sql.js'), 'db.query("SELECT * FROM users WHERE name = " + name);');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const sql = findings.find(f => f.title === 'Potential SQL Injection');
    expect(sql).toBeDefined();
  });

  test('detects eval with dynamic input', async () => {
    fs.writeFileSync(path.join(testDir, 'eval.js'), 'eval(input);');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const ev = findings.find(f => f.title === 'Dangerous Eval usage');
    expect(ev).toBeDefined();
  });

  test('handles binary files without crash', async () => {
    fs.writeFileSync(path.join(testDir, 'binary.bin'), new Uint8Array([0, 1, 2, 3, 4, 0, 5, 6, 7]));
    const analyzer = new XRaySecurityAnalyzer();
    await expect(analyzer.scan(mockContext)).resolves.not.toThrow();
  });

  test('handles 0-byte files', async () => {
    fs.writeFileSync(path.join(testDir, 'empty.txt'), '');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    expect(findings.length).toBe(0);
  });

  test('exportReport formats report correctly', async () => {
    const analyzer = new XRaySecurityAnalyzer();
    const reportJson = await analyzer.exportReport(mockContext, 'json');
    expect(JSON.parse(reportJson)).toBeInstanceOf(Array);

    const reportMd = await analyzer.exportReport(mockContext, 'markdown');
    expect(reportMd).toContain('# Security Report');
  });

  test('detects vulnerable dependencies using cached OSV database', async () => {
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          vulndep: '1.0.0'
        }
      })
    );

    const cacheDir = path.join(testDir, '.xray-cache');
    const osvCacheDir = path.join(cacheDir, 'osv-db', 'npm', 'vulndep');
    fs.mkdirSync(osvCacheDir, { recursive: true });
    
    fs.writeFileSync(
      path.join(osvCacheDir, '1_0_0.json'),
      JSON.stringify([
        {
          id: 'GHSA-test-123',
          details: 'Severe remote code execution'
        }
      ])
    );

    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    
    const vuln = findings.find(f => f.id === 'sec-cve-vulndep-GHSA-test-123');
    expect(vuln).toBeDefined();
    expect(vuln?.title).toBe('Vulnerable Dependency: vulndep');
    expect(vuln?.severity).toBe('HIGH');
    expect(vuln?.reasoning).toBe('Severe remote code execution');
  });

  test('detects permissive CORS and active debug configurations', async () => {
    fs.writeFileSync(path.join(testDir, 'cors.js'), 'res.setHeader("Access-Control-Allow-Origin", "*");');
    fs.writeFileSync(path.join(testDir, 'debug.py'), 'DEBUG = True');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);

    const cors = findings.find(f => f.title === 'Permissive CORS Configuration');
    expect(cors).toBeDefined();
    expect(cors?.severity).toBe('MEDIUM');

    const debug = findings.find(f => f.title === 'Active Debug Configuration');
    expect(debug).toBeDefined();
    expect(debug?.severity).toBe('MEDIUM');
  });

  test('detects innerHTML XSS injection', async () => {
    fs.writeFileSync(path.join(testDir, 'xss.js'), 'element.innerHTML = userInput;');
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const xss = findings.find(f => f.title === 'Cross-Site Scripting (XSS) via innerHTML');
    expect(xss).toBeDefined();
    expect(xss?.severity).toBe('HIGH');
  });

  test('caps high entropy findings at 200', async () => {
    // Deterministic max-entropy strings (charset cycled per line) so the test is stable.
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
    let content = '';
    for (let i = 0; i < 210; i++) {
      let highEntropyStr = '';
      for (let j = 0; j < 64; j++) {
        highEntropyStr += charset[(j + i) % charset.length];
      }
      content += `const key${i} = "${highEntropyStr}";\n`;
    }
    fs.writeFileSync(path.join(testDir, 'entropy-cap.js'), content);
    
    const analyzer = new XRaySecurityAnalyzer();
    const findings = await analyzer.scan(mockContext);
    const entropyFindings = findings.filter(f => f.title === 'High Entropy Cryptographic Key');
    expect(entropyFindings.length).toBe(200);
  });
});
