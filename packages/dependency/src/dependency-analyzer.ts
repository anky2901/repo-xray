import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { parse as parseYaml } from 'yaml';
import type { ScanContext, Analyzer, Finding, Severity } from '@repo-xray/types';

export interface ParsedDependency {
  name: string;
  version: string;
  ecosystem: 'npm' | 'pypi';
  dev: boolean;
}

export interface DuplicateDependency {
  name: string;
  versions: string[];
}

export interface OversizedReplacement {
  name: string;
  replacement: string;
  note: string;
}

export interface DependencyAnalysis {
  totalDeps: number;
  dependencies: ParsedDependency[];
  duplicates: DuplicateDependency[];
  vulnerableCount: number;
  findings: Finding[];
  report: string;
  score: number;
}

const OVERSIZED_REPLACEMENTS: Record<string, OversizedReplacement> = {
  moment: { name: 'moment', replacement: 'dayjs', note: 'moment (~4.2MB, legacy/maintenance mode) → dayjs (~6KB, same API surface)' },
  request: { name: 'request', replacement: 'got', note: 'request is deprecated and unmaintained → got (modern, smaller, actively maintained)' },
  uuid: { name: 'uuid', replacement: 'crypto.randomUUID()', note: 'uuid → native crypto.randomUUID() (no dependency, Node 14.17+)' },
  colors: { name: 'colors', replacement: 'chalk', note: 'colors had a supply-chain incident → chalk (safer, well maintained)' },
  faker: { name: 'faker', replacement: '@faker-js/faker', note: 'original faker is abandoned → @faker-js/faker (community fork)' },
};

const COPYLEFT_LICENSES: Record<string, Severity> = {
  'GPL-2.0': 'MEDIUM',
  'GPL-3.0': 'MEDIUM',
  'LGPL-2.1': 'LOW',
  'LGPL-3.0': 'LOW',
  'AGPL-3.0': 'HIGH',
  'AGPL-1.0': 'HIGH',
};

function cleanSemver(range: string): string {
  return range.replace(/^[\^~>=<\s]+/, '').trim();
}

function fetchNpmMeta(pkg: string, cacheDir: string, offline: boolean, ttlDays = 7): Promise<{ lastPublish?: string } | null> {
  const safe = pkg.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  const dir = path.join(cacheDir, 'npm-meta');
  const cacheFile = path.join(dir, `${safe}.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays < ttlDays) {
        return Promise.resolve(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      }
    } catch {
      /* fall through to refetch */
    }
  }

  if (offline) return Promise.resolve(null);

  return new Promise((resolve) => {
    let req: ReturnType<typeof https.get>;
    try {
      req = https.get(
        {
          hostname: 'registry.npmjs.org',
          path: `/${encodeURIComponent(pkg).replace('%40', '@')}`,
          method: 'GET',
          headers: { Accept: 'application/vnd.npm.install-v1+json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const times = parsed.time || {};
              const versions = Object.keys(times).filter((k) => k !== 'created' && k !== 'modified');
              const lastPublish = versions.length ? times[versions[versions.length - 1]] : times.modified;
              const meta = { lastPublish };
              try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(cacheFile, JSON.stringify(meta), 'utf-8');
              } catch {
                /* cache write best-effort */
              }
              resolve(meta);
            } catch {
              resolve(null);
            }
          });
        }
      );
    } catch {
      resolve(null);
      return;
    }
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

export function parseManifests(workspace: string): ParsedDependency[] {
  const deps: ParsedDependency[] = [];

  const pkgPath = path.join(workspace, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      for (const [name, range] of Object.entries(json.dependencies || {})) {
        deps.push({ name, version: cleanSemver(String(range)), ecosystem: 'npm', dev: false });
      }
      for (const [name, range] of Object.entries(json.devDependencies || {})) {
        deps.push({ name, version: cleanSemver(String(range)), ecosystem: 'npm', dev: true });
      }
    } catch {
      /* malformed manifest ignored */
    }
  }

  const reqPath = path.join(workspace, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    try {
      const lines = fs.readFileSync(reqPath, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const m = trimmed.match(/^([A-Za-z0-9._-]+)\s*(?:[<>=!~]=?\s*([0-9][0-9A-Za-z.*-]*))?/);
        if (m) deps.push({ name: m[1], version: m[2] || '*', ecosystem: 'pypi', dev: false });
      }
    } catch {
      /* ignore */
    }
  }

  const pyprojectPath = path.join(workspace, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      const arrMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (arrMatch) {
        const items = arrMatch[1].match(/["']([^"']+)["']/g) || [];
        for (const item of items) {
          const raw = item.replace(/["']/g, '').trim();
          const m = raw.match(/^([A-Za-z0-9._-]+)\s*(?:[<>=!~]=?\s*([0-9][0-9A-Za-z.*-]*))?/);
          if (m && !deps.some((d) => d.name === m[1] && d.ecosystem === 'pypi')) {
            deps.push({ name: m[1], version: m[2] || '*', ecosystem: 'pypi', dev: false });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  deps.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  return deps;
}

export function detectDuplicates(workspace: string): DuplicateDependency[] {
  const versionMap = new Map<string, Set<string>>();

  const add = (name: string, version: string): void => {
    if (!name || !version) return;
    if (!versionMap.has(name)) versionMap.set(name, new Set());
    versionMap.get(name)!.add(version);
  };

  // package-lock.json (v2/v3): "packages" keys are install paths.
  const lockPath = path.join(workspace, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (lock.packages) {
        for (const [p, info] of Object.entries(lock.packages as Record<string, { version?: string }>)) {
          if (!p) continue;
          const idx = p.lastIndexOf('node_modules/');
          if (idx === -1) continue;
          const name = p.slice(idx + 'node_modules/'.length);
          if (info.version) add(name, info.version);
        }
      } else if (lock.dependencies) {
        const walk = (deps: Record<string, { version?: string; dependencies?: Record<string, unknown> }>): void => {
          for (const [name, info] of Object.entries(deps)) {
            if (info.version) add(name, info.version);
            if (info.dependencies) walk(info.dependencies as Record<string, { version?: string }>);
          }
        };
        walk(lock.dependencies);
      }
    } catch {
      /* ignore */
    }
  }

  // pnpm-lock.yaml: "packages" keys like "/name@1.2.3" or "/@scope/name@1.2.3".
  const pnpmPath = path.join(workspace, 'pnpm-lock.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const lock = parseYaml(fs.readFileSync(pnpmPath, 'utf-8')) as { packages?: Record<string, unknown> };
      if (lock && lock.packages) {
        for (const key of Object.keys(lock.packages)) {
          const clean = key.replace(/^\//, '');
          const at = clean.lastIndexOf('@');
          if (at <= 0) continue;
          const name = clean.slice(0, at);
          const version = clean.slice(at + 1).split('(')[0];
          add(name, version);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const duplicates: DuplicateDependency[] = [];
  for (const [name, versions] of versionMap.entries()) {
    if (versions.size > 1) {
      duplicates.push({ name, versions: Array.from(versions).sort((a, b) => a.localeCompare(b)) });
    }
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name));
  return duplicates;
}

function readProjectLicense(workspace: string): string | null {
  const pkgPath = path.join(workspace, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (typeof json.license === 'string') return json.license;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function detectLicenseConflicts(workspace: string, deps: ParsedDependency[], findings: Finding[]): void {
  const nmDir = path.join(workspace, 'node_modules');
  if (!fs.existsSync(nmDir)) return;

  const projectLicense = readProjectLicense(workspace);
  const projectIsPermissive = projectLicense
    ? /MIT|Apache|BSD|ISC|Unlicense/i.test(projectLicense)
    : true;

  for (const dep of deps) {
    if (dep.ecosystem !== 'npm') continue;
    const depPkg = path.join(nmDir, dep.name, 'package.json');
    if (!fs.existsSync(depPkg)) continue;
    let license = '';
    try {
      const json = JSON.parse(fs.readFileSync(depPkg, 'utf-8'));
      license = typeof json.license === 'string' ? json.license : json.license?.type || '';
    } catch {
      continue;
    }
    if (!license) continue;

    const normalized = license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i)[0].trim();
    const matchKey = Object.keys(COPYLEFT_LICENSES).find((k) => normalized.toUpperCase().startsWith(k.toUpperCase()));
    if (matchKey && projectIsPermissive) {
      findings.push({
        id: `dep-license-${dep.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
        module: 'dependency',
        title: `License Conflict: ${dep.name} (${normalized})`,
        summary: `Dependency "${dep.name}" is ${normalized}, which conflicts with a permissive project license (${projectLicense || 'unspecified'}).`,
        severity: COPYLEFT_LICENSES[matchKey],
        confidence: 80,
        evidence: [{ file: `node_modules/${dep.name}/package.json`, snippet: `license: ${normalized}` }],
        reasoning: `Copyleft licenses such as ${normalized} can require derivative works to adopt the same license terms. Shipping it inside a permissively licensed project may create distribution obligations you did not intend. Review whether this dependency can be replaced or isolated.`,
        reproducible: true,
        tags: ['dependency', 'license'],
      });
    }
  }
}

export class XRayDependencyAnalyzer implements Analyzer {
  readonly id = 'dependency';
  readonly name = 'Dependency X-Ray';
  readonly version = '0.1.0';
  readonly offline = false;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  async analyze(context: ScanContext): Promise<DependencyAnalysis> {
    const workspace = context.workspacePath;
    const offline = context.offline === true;
    const cacheDir = path.join(workspace, '.xray-cache');
    const findings: Finding[] = [];

    const dependencies = parseManifests(workspace);
    context.logger.info(`[M16:dependency] Parsed ${dependencies.length} declared dependencies`);

    const cveFindings = (context.priorFindings || []).filter((f) => f.tags.includes('cve'));
    const vulnerableCount = cveFindings.length;

    for (const dep of dependencies) {
      const repl = OVERSIZED_REPLACEMENTS[dep.name];
      if (repl && dep.ecosystem === 'npm') {
        findings.push({
          id: `dep-oversized-${dep.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
          module: 'dependency',
          title: `Heavyweight Dependency: ${dep.name}`,
          summary: `"${dep.name}" has a lighter, recommended alternative: ${repl.replacement}.`,
          severity: 'LOW',
          confidence: 75,
          evidence: [{ file: 'package.json', snippet: `"${dep.name}": "${dep.version}"` }],
          reasoning: `${repl.note}. Swapping reduces install size and, in some cases, removes an unmaintained or compromised dependency from the supply chain.`,
          reproducible: true,
          tags: ['dependency', 'bundle-size'],
        });
      }
    }

    const duplicates = detectDuplicates(workspace);
    for (const dup of duplicates) {
      findings.push({
        id: `dep-duplicate-${dup.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
        module: 'dependency',
        title: `Duplicate Dependency: ${dup.name}`,
        summary: `"${dup.name}" is installed at ${dup.versions.length} different versions: ${dup.versions.join(', ')}.`,
        severity: 'LOW',
        confidence: 85,
        evidence: [{ file: 'lockfile', snippet: `${dup.name}: ${dup.versions.join(', ')}` }],
        reasoning: `Multiple resolved versions of the same package inflate install size and bundle output, and can cause subtle bugs when two copies of a module hold separate state. Deduplicating or aligning version ranges resolves this.`,
        reproducible: true,
        tags: ['dependency', 'duplicate'],
      });
    }

    detectLicenseConflicts(workspace, dependencies, findings);

    if (!offline) {
      const npmDeps = dependencies.filter((d) => d.ecosystem === 'npm');
      const checkList = npmDeps.slice(0, 60);
      const metas = await Promise.all(checkList.map((dep) => fetchNpmMeta(dep.name, cacheDir, offline)));
      for (let i = 0; i < checkList.length; i++) {
        const dep = checkList[i];
        const meta = metas[i];
        if (meta && meta.lastPublish) {
          const ageDays = (Date.now() - Date.parse(meta.lastPublish)) / (1000 * 60 * 60 * 24);
          if (Number.isFinite(ageDays) && ageDays > 365) {
            findings.push({
              id: `dep-abandoned-${dep.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
              module: 'dependency',
              title: `Possibly Abandoned Dependency: ${dep.name}`,
              summary: `"${dep.name}" had no new release in ${Math.floor(ageDays / 365)}+ year(s).`,
              severity: 'LOW',
              confidence: 60,
              evidence: [{ file: 'package.json', snippet: `"${dep.name}" last published ${meta.lastPublish.slice(0, 10)}` }],
              reasoning: `The most recent release of ${dep.name} is over a year old. Unmaintained dependencies accumulate unpatched vulnerabilities and compatibility gaps. Confirm the project is still maintained or evaluate an actively maintained alternative.`,
              reproducible: true,
              tags: ['dependency', 'abandoned'],
            });
          }
        }
      }
    } else {
      context.logger.warn('[M16:dependency] Offline mode: skipping npm registry freshness checks (using cache only).');
    }

    const score = this.computeScore(vulnerableCount, findings);
    const report = this.buildReport(dependencies, duplicates, findings, cveFindings, score, offline);

    context.logger.info(`[M16:dependency] Completed — ${findings.length} findings, score ${score}`);
    return { totalDeps: dependencies.length, dependencies, duplicates, vulnerableCount, findings, report, score };
  }

  private computeScore(vulnerableCount: number, findings: Finding[]): number {
    let score = 100;
    score -= vulnerableCount * 12;
    for (const f of findings) {
      if (f.severity === 'HIGH') score -= 8;
      else if (f.severity === 'MEDIUM') score -= 4;
      else if (f.severity === 'LOW') score -= 2;
    }
    return Math.max(0, Math.min(100, score));
  }

  private buildReport(
    deps: ParsedDependency[],
    duplicates: DuplicateDependency[],
    findings: Finding[],
    cveFindings: Finding[],
    score: number,
    offline: boolean
  ): string {
    let md = `# Dependency Report\n\n`;
    md += `Dependency Score: ${score}/100\n`;
    md += `Declared dependencies: ${deps.length}\n`;
    md += `Known vulnerabilities (from Security X-Ray): ${cveFindings.length}\n`;
    md += `Duplicate packages: ${duplicates.length}\n`;
    if (offline) md += `\n> Offline mode: registry freshness checks were skipped; results rely on cached data.\n`;
    md += `\n`;

    if (cveFindings.length > 0) {
      md += `## Vulnerable Dependencies (${cveFindings.length})\n\n`;
      for (const f of [...cveFindings].sort((a, b) => a.id.localeCompare(b.id))) {
        md += `### [${f.severity}] ${f.title}\n`;
        md += `- **Summary:** ${f.summary}\n`;
        md += `- **Confidence:** ${f.confidence}%\n\n`;
      }
    }

    const section = (title: string, tag: string): void => {
      const list = findings.filter((f) => f.tags.includes(tag)).sort((a, b) => a.id.localeCompare(b.id));
      if (list.length === 0) return;
      md += `## ${title} (${list.length})\n\n`;
      for (const f of list) {
        md += `### [${f.severity}] ${f.title}\n`;
        md += `- **Summary:** ${f.summary}\n`;
        md += `- **Confidence:** ${f.confidence}%\n`;
        md += `- **Why:** ${f.reasoning}\n\n`;
      }
    };

    section('Heavyweight Dependencies', 'bundle-size');
    section('Duplicate Dependencies', 'duplicate');
    section('License Conflicts', 'license');
    section('Abandoned Dependencies', 'abandoned');

    if (findings.length === 0 && cveFindings.length === 0) {
      md += `*No dependency issues detected.*\n`;
    }
    return md;
  }

  async scan(context: ScanContext): Promise<Finding[]> {
    return (await this.analyze(context)).findings;
  }

  async exportReport(context: ScanContext, format: 'json' | 'markdown'): Promise<string> {
    const analysis = await this.analyze(context);
    return format === 'json' ? JSON.stringify(analysis.findings, null, 2) : analysis.report;
  }
}
