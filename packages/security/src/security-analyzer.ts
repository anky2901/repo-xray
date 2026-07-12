import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';
import type { ScanContext, Analyzer, Finding, Severity } from '@repo-xray/types';
import { buildIgnoreFilter, XRayConfig } from '@repo-xray/shared';

interface OSVVulnerability {
  id: string;
  details?: string;
  [key: string]: unknown;
}

export function shannonEntropy(str: string): number {
  if (!str) return 0;
  const freq: Record<string, number> = {};
  for (const c of str) {
    freq[c] = (freq[c] || 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: Severity;
  confidence: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'AWS API Key',
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: 'CRITICAL',
    confidence: 95,
  },
  {
    name: 'GitHub Personal Access Token',
    regex: /ghp_[a-zA-Z0-9]{36}/g,
    severity: 'CRITICAL',
    confidence: 98,
  },
  {
    name: 'OpenAI API Key',
    regex: /sk-[a-zA-Z0-9]{48}/g,
    severity: 'CRITICAL',
    confidence: 96,
  },
  {
    name: 'Anthropic API Key',
    regex: /sk-ant-[a-zA-Z0-9-]{90,}/g,
    severity: 'CRITICAL',
    confidence: 97,
  },
  {
    name: 'Stripe API Key',
    regex: /sk_live_[a-zA-Z0-9]{24}/g,
    severity: 'CRITICAL',
    confidence: 95,
  },
  {
    name: 'Stripe Test API Key',
    regex: /sk_test_[a-zA-Z0-9]{24}/g,
    severity: 'HIGH',
    confidence: 90,
  },
  {
    name: 'JSON Web Token',
    regex: /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    severity: 'HIGH',
    confidence: 85,
  },
  {
    name: 'Private Key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'CRITICAL',
    confidence: 99,
  },
  {
    name: 'Password in Code',
    regex: /password\s*=\s*["']([^"']{8,})["']/gi,
    severity: 'HIGH',
    confidence: 70,
  },
  {
    name: 'Database URL with Credentials',
    regex: /(postgres|mysql|mongodb):\/\/[^:]+:([^@]+)@/g,
    severity: 'CRITICAL',
    confidence: 90,
  },
];

export function redactSecret(value: string, patternName: string): string {
  if (patternName === 'AWS API Key') return 'AKIA[REDACTED]';
  if (patternName === 'OpenAI API Key') return 'sk-[REDACTED]';
  if (patternName === 'GitHub Personal Access Token') return 'ghp_[REDACTED]';
  if (patternName === 'Stripe API Key') return 'sk_live_[REDACTED]';
  if (patternName === 'Stripe Test API Key') return 'sk_test_[REDACTED]';
  return '[REDACTED]';
}

function queryOsvApi(packageName: string, version: string, ecosystem: string): Promise<OSVVulnerability[]> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      version,
      package: {
        name: packageName,
        ecosystem,
      },
    });

    const options = {
      hostname: 'api.osv.dev',
      port: 443,
      path: '/v1/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.vulns || []);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => {
      resolve([]);
    });

    req.write(postData);
    req.end();
  });
}

export class XRaySecurityAnalyzer implements Analyzer {
  readonly id = 'security';
  readonly name = 'Security X-Ray';
  readonly version = '0.1.0';
  readonly offline = false;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  private async checkOsvWithCache(
    packageName: string,
    version: string,
    ecosystem: string,
    cacheDir: string,
    offline = false
  ): Promise<OSVVulnerability[]> {
    const safePkg = packageName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeVer = version.replace(/[^a-zA-Z0-9_-]/g, '_');
    const osvCacheDir = path.join(cacheDir, 'osv-db', ecosystem, safePkg);
    const cacheFile = path.join(osvCacheDir, `${safeVer}.json`);

    if (fs.existsSync(cacheFile)) {
      try {
        const stat = fs.statSync(cacheFile);
        const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        if (ageDays < 7) {
          const content = fs.readFileSync(cacheFile, 'utf-8');
          return JSON.parse(content);
        }
      } catch {}
    }

    if (offline) return [];

    const vulns = await queryOsvApi(packageName, version, ecosystem);
    try {
      if (!fs.existsSync(osvCacheDir)) {
        fs.mkdirSync(osvCacheDir, { recursive: true });
      }
      fs.writeFileSync(cacheFile, JSON.stringify(vulns), 'utf-8');
    } catch {}
    return vulns;
  }

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const ignoreFilter = buildIgnoreFilter(context.workspacePath, context.config as XRayConfig);
    const files = this.getScanFiles(context.workspacePath).filter(f => !ignoreFilter(f));
    context.logger.info(`[M3:security] Starting scan — ${files.length} files`);

    for (const file of files) {
      try {
        const relPath = path.relative(context.workspacePath, file).replace(/\\/g, '/');
        const filename = path.basename(file);

        if (filename === '.env' || filename === '.env.local' || filename === '.env.production') {
          findings.push({
            id: `sec-env-${relPath}`,
            module: 'security',
            title: 'Committed Environment File',
            summary: `Environment configuration file "${filename}" is committed to the repository.`,
            severity: 'CRITICAL',
            confidence: 100,
            evidence: [{ file: relPath, line: 1, snippet: `Environment file ${filename}` }],
            reasoning: 'Environment files contain database credentials, private tokens, and configuration keys. Committing them risks exposing secrets in git history.',
            reproducible: true,
            tags: ['leak', 'env'],
          });
          continue;
        }

        let isText = false;
        let content = '';
        try {
          const fd = fs.openSync(file, 'r');
          const checkBuf = new Uint8Array(512);
          const bytesRead = fs.readSync(fd, checkBuf, 0, 512, 0);
          fs.closeSync(fd);

          const checkLen = Math.min(bytesRead, 512);
          let hasNull = false;
          for (let i = 0; i < checkLen; i++) {
            if (checkBuf[i] === 0) {
              hasNull = true;
              break;
            }
          }
          if (bytesRead > 0 && !hasNull) {
            isText = true;
            content = fs.readFileSync(file, 'utf-8');
          }
        } catch {
          // unreadable file; skip content scan
        }

        if (!isText) continue;

        this.scanFileSecrets(relPath, content, findings);
        this.scanFileDangerousPatterns(relPath, content, findings);
        this.scanFileConfigs(relPath, content, findings);
      } catch (err: unknown) {
        const error = err as Error;
        context.logger.error(`[M3:security] ERROR scanning ${path.relative(context.workspacePath, file)}\n  Error: ${error.message}`);
      }
    }

    await this.scanDependencies(context, findings);

    try {
      const gitOut = execSync('git ls-files --error-unmatch .env', {
        cwd: context.workspacePath,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
      if (gitOut) {
        findings.push({
          id: 'sec-env-history',
          module: 'security',
          title: 'Environment File Tracked in Git History',
          summary: '.env file exists and is tracked in git index.',
          severity: 'CRITICAL',
          confidence: 100,
          evidence: [{ file: '.env' }],
          reasoning: 'An environment file is tracked in the repository, making it visible to anyone with access.',
          reproducible: true,
          tags: ['leak', 'git'],
        });
      }
    } catch {}

    context.logger.info(`[M3:security] Completed — ${findings.length} findings`);
    return findings;
  }

  private scanFileSecrets(relPath: string, content: string, findings: Finding[]): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];

      for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(lineText);
        if (match) {
          if (pattern.name === 'Password in Code') {
            const pwd = match[1];
            if (pwd && shannonEntropy(pwd) < 2.5) {
              continue;
            }
          }

          findings.push({
            id: `sec-secret-${relPath}-${i + 1}-${pattern.name.replace(/\s+/g, '-').toLowerCase()}`,
            module: 'security',
            title: `Hardcoded ${pattern.name}`,
            summary: `Detected matching pattern for ${pattern.name} in code.`,
            severity: pattern.severity,
            confidence: pattern.confidence,
            evidence: [
              {
                file: relPath,
                line: i + 1,
                snippet: lineText.replace(match[0], redactSecret(match[0], pattern.name)),
              },
            ],
            reasoning: `Found a string matching the known signature of ${pattern.name}. Hardcoding keys compromises supply chain security.`,
            reproducible: true,
            tags: ['secret', 'credential'],
          });
        }
      }

      const words = lineText.match(/[a-zA-Z0-9/+]{24,128}/g);
      if (words) {
        for (const word of words) {
          if (word.startsWith('eyJ') || word.includes('-----')) continue;

          const entropy = shannonEntropy(word);
          if (entropy > 5.2) {
            const existingEntropyCount = findings.filter(f => f.title === 'High Entropy Cryptographic Key').length;
            if (existingEntropyCount >= 200) {
              continue;
            }

            findings.push({
              id: `sec-entropy-${relPath}-${i + 1}`,
              module: 'security',
              title: 'High Entropy Cryptographic Key',
              summary: 'Detected generic high-entropy credential string.',
              severity: 'HIGH',
              confidence: 60,
              evidence: [
                {
                  file: relPath,
                  line: i + 1,
                  snippet: lineText.replace(word, '[REDACTED]'),
                },
              ],
              reasoning: `Detected word with Shannon entropy of ${entropy.toFixed(2)} bits per character, indicating it is likely a cryptographic token or secret key.`,
              reproducible: true,
              tags: ['secret', 'entropy'],
            });
          }
        }
      }
    }
  }

  private scanFileDangerousPatterns(relPath: string, content: string, findings: Finding[]): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/eval\s*\(/g.test(line) && !line.includes('//') && !line.includes('/*')) {
        findings.push({
          id: `sec-eval-${relPath}-${i + 1}`,
          module: 'security',
          title: 'Dangerous Eval usage',
          summary: 'Detected execution of dynamic input via eval().',
          severity: 'HIGH',
          confidence: 85,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim() }],
          reasoning: 'eval() executes string code in the local environment context, enabling Arbitrary Code Execution (ACE) if combined with untrusted user input.',
          reproducible: true,
          tags: ['dangerous-pattern', 'code-injection'],
        });
      }

      if (/\.innerHTML\s*=/g.test(line) && !line.includes('//') && !line.includes('/*')) {
        findings.push({
          id: `sec-innerhtml-${relPath}-${i + 1}`,
          module: 'security',
          title: 'Cross-Site Scripting (XSS) via innerHTML',
          summary: 'Detected writing dynamic output directly to innerHTML.',
          severity: 'HIGH',
          confidence: 80,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim() }],
          reasoning: 'Writing user input directly into a DOM node\'s innerHTML permits structural HTML injection and executing arbitrary scripts (XSS).',
          reproducible: true,
          tags: ['dangerous-pattern', 'xss'],
        });
      }

      if (/(?:select|insert|update|delete)[\s\S]*?\+[\s\S]*?/gi.test(line) && (line.includes('query(') || line.includes('execute('))) {
        findings.push({
          id: `sec-sql-concat-${relPath}-${i + 1}`,
          module: 'security',
          title: 'Potential SQL Injection',
          summary: 'Detected SQL command string construction via string concatenation.',
          severity: 'HIGH',
          confidence: 75,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim() }],
          reasoning: 'Constructing SQL commands dynamically using variable concatenation permits SQL injection payload execution.',
          reproducible: true,
          tags: ['dangerous-pattern', 'sql-injection'],
        });
      }
    }
  }

  private scanFileConfigs(relPath: string, content: string, findings: Finding[]): void {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/(?:origin\s*:\s*['"]\*['"]|Access-Control-Allow-Origin.*?\*)/i.test(line)) {
        findings.push({
          id: `sec-cors-${relPath}-${i + 1}`,
          module: 'security',
          title: 'Permissive CORS Configuration',
          summary: 'CORS policy configured to allow wildcard origin access (*).',
          severity: 'MEDIUM',
          confidence: 85,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim() }],
          reasoning: 'Allowing all origins via wildcard CORS enables untrusted sites to read sensitive responses from cross-origin clients.',
          reproducible: true,
          tags: ['config', 'cors'],
        });
      }

      if (/(?:DEBUG\s*=\s*True|debug\s*:\s*true)/.test(line) && !line.includes('//') && !line.includes('#')) {
        findings.push({
          id: `sec-debug-${relPath}-${i + 1}`,
          module: 'security',
          title: 'Active Debug Configuration',
          summary: 'Application debug logging or environment is set to active (true).',
          severity: 'MEDIUM',
          confidence: 80,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim() }],
          reasoning: 'Leaving debug mode enabled exposes verbose diagnostics, system variables, and stack traces to end users.',
          reproducible: true,
          tags: ['config', 'debug'],
        });
      }
    }
  }

  private async scanDependencies(context: ScanContext, findings: Finding[]): Promise<void> {
    const workspace = context.workspacePath;
    const cacheDir = path.join(workspace, '.xray-cache');

    const packageJsonPath = path.join(workspace, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const deps = {
          ...(content.dependencies || {}),
          ...(content.devDependencies || {}),
        };

        const entries = Object.entries(deps)
          .map(([pkg, ver]) => ({ pkg, ver: ver as string, cleanVer: (ver as string).replace(/[^0-9.]/g, '') }))
          .filter((e) => e.cleanVer);

        const offline = context.offline === true;
        const results = await Promise.all(
          entries.map(async (e) => ({
            entry: e,
            vulns: await this.checkOsvWithCache(e.pkg, e.cleanVer, 'npm', cacheDir, offline),
          }))
        );

        for (const { entry, vulns } of results) {
          if (vulns && vulns.length > 0) {
            for (const vuln of vulns) {
              findings.push({
                id: `sec-cve-${entry.pkg}-${vuln.id}`,
                module: 'security',
                title: `Vulnerable Dependency: ${entry.pkg}`,
                summary: `${entry.pkg}@${entry.cleanVer} contains security vulnerability ${vuln.id}.`,
                severity: 'HIGH',
                confidence: 95,
                evidence: [{ file: 'package.json', snippet: `"${entry.pkg}": "${entry.ver}"` }],
                reasoning: vuln.details || 'Known security vulnerability.',
                reproducible: true,
                tags: ['supply-chain', 'cve'],
              });
            }
          }
        }
      } catch {}
    }
  }

  private getScanFiles(dir: string): string[] {
    const results: string[] = [];
    const ignoreList = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '__pycache__',
      'vendor',
      '.cache',
      '.xray-cache',
      '.xray-reports',
    ];

    function walk(current: string): void {
      if (!fs.existsSync(current)) return;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreList.includes(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    }

    walk(dir);
    return results;
  }

  async exportReport(context: ScanContext, format: 'json' | 'markdown'): Promise<string> {
    const findings = await this.scan(context);
    if (format === 'json') {
      return JSON.stringify(findings, null, 2);
    }
    return `# Security Report`;
  }
}
