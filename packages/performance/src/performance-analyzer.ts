import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding, Severity } from '@repo-xray/types';

export interface PerformanceAnalysis {
  filesScanned: number;
  score: number;
  findings: Finding[];
  report: string;
}

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  'vendor',
  '.cache',
  'coverage',
  '.xray-cache',
  '.xray-reports',
]);

interface PerfPattern {
  title: string;
  regex: RegExp;
  severity: Severity;
  confidence: number;
  reason: string;
  tags: string[];
}

const PATTERNS: PerfPattern[] = [
  {
    title: 'await inside loop',
    regex: /\b(for|while)\b[^\n;]*[\s\S]{0,200}?\bawait\b/,
    severity: 'MEDIUM',
    confidence: 55,
    reason: 'Awaiting inside a loop serializes asynchronous work that could often run concurrently. Collecting the promises and awaiting Promise.all (with a sensible concurrency cap) usually cuts wall-clock time sharply.',
    tags: ['performance', 'async'],
  },
  {
    title: 'Nested array iteration (possible O(n^2))',
    regex: /\.(forEach|map|filter|find|some|every)\s*\([^)]*\)[\s\S]{0,120}?\.(forEach|map|filter|find|includes|indexOf)\s*\(/,
    severity: 'LOW',
    confidence: 45,
    reason: 'Iterating one collection inside another is quadratic. For membership checks, a Set or Map lookup turns the inner pass into O(1) and the whole operation into O(n).',
    tags: ['performance', 'complexity'],
  },
  {
    title: 'Blocking synchronous file I/O',
    regex: /\b(readFileSync|writeFileSync|readdirSync|existsSync)\s*\(/,
    severity: 'LOW',
    confidence: 40,
    reason: 'Synchronous fs calls block the event loop. In a request path or hot loop this stalls all concurrent work; prefer the promise-based fs API there. In startup or CLI code it is usually fine.',
    tags: ['performance', 'io'],
  },
  {
    title: 'JSON deep clone',
    regex: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
    severity: 'LOW',
    confidence: 70,
    reason: 'JSON.parse(JSON.stringify(x)) is a slow deep clone that also drops functions, dates, and undefined. structuredClone is faster and preserves more types.',
    tags: ['performance', 'allocation'],
  },
  {
    title: 'Regex compiled inside loop',
    regex: /\b(for|while)\b[^\n;]*[\s\S]{0,160}?new RegExp\s*\(/,
    severity: 'LOW',
    confidence: 50,
    reason: 'Constructing a RegExp on every iteration recompiles the pattern each time. Hoisting it above the loop compiles once and reuses it.',
    tags: ['performance', 'cpu'],
  },
];

function isTestFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    /(^|\/)(tests?|__tests__|spec)\//.test(rel.toLowerCase())
  );
}

function walk(dir: string, workspace: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, workspace, out);
    } else if (entry.isFile() && SOURCE_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(workspace, full).replace(/\\/g, '/'));
    }
  }
}

export class XRayPerformanceAnalyzer implements Analyzer {
  readonly id = 'performance';
  readonly name = 'Performance X-Ray';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): PerformanceAnalysis {
    const workspace = context.workspacePath;
    const findings: Finding[] = [];
    const rels: string[] = [];
    walk(workspace, workspace, rels);
    const sourceFiles = rels.filter((r) => !isTestFile(r)).sort((a, b) => a.localeCompare(b));

    context.logger.info(`[M8:performance] Scanning ${sourceFiles.length} source files`);

    const perTitleCap = 100;
    const titleCounts: Record<string, number> = {};

    for (const rel of sourceFiles) {
      let source = '';
      try {
        source = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      } catch {
        continue;
      }
      const lines = source.split(/\r?\n/);
      const seenLines = new Set<number>();
      for (let i = 0; i < lines.length; i++) {
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        for (const pat of PATTERNS) {
          if ((titleCounts[pat.title] || 0) >= perTitleCap) continue;
          if (!this.matches(pat, lines[i], window)) continue;
          if (seenLines.has(i)) continue;
          seenLines.add(i);
          titleCounts[pat.title] = (titleCounts[pat.title] || 0) + 1;
          findings.push({
            id: `perf-${pat.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${rel.replace(/[^a-zA-Z0-9]/g, '-')}-${i + 1}`,
            module: 'performance',
            title: pat.title,
            summary: `Possible performance hotspot in "${rel}".`,
            severity: pat.severity,
            confidence: pat.confidence,
            evidence: [{ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 200) }],
            reasoning: pat.reason,
            reproducible: true,
            tags: pat.tags,
          });
          break;
        }
      }
    }

    const score = this.computeScore(findings);
    const report = this.buildReport(sourceFiles.length, findings, score);

    context.logger.info(`[M8:performance] Completed — ${findings.length} findings, score ${score}`);
    return { filesScanned: sourceFiles.length, score, findings, report };
  }

  private matches(pat: PerfPattern, line: string, window: string): boolean {
    pat.regex.lastIndex = 0;
    if (pat.title === 'await inside loop') {
      return /\bawait\b/.test(line) && /\b(for|while)\b/.test(window);
    }
    if (pat.title === 'Regex compiled inside loop') {
      return /new RegExp\s*\(/.test(line) && /\b(for|while)\b/.test(window);
    }
    return pat.regex.test(line);
  }

  private computeScore(findings: Finding[]): number {
    let score = 100;
    for (const f of findings) {
      if (f.severity === 'MEDIUM') score -= 4;
      else if (f.severity === 'LOW') score -= 1;
    }
    return Math.max(0, Math.min(100, score));
  }

  private buildReport(filesScanned: number, findings: Finding[], score: number): string {
    let md = `# Performance Report\n\n`;
    md += `Performance Score: ${score}/100\n`;
    md += `Files scanned: ${filesScanned}\n`;
    md += `Hotspots: ${findings.length}\n\n`;

    if (findings.length === 0) {
      md += `*No common performance anti-patterns detected.*\n`;
      return md;
    }

    const byTitle = new Map<string, Finding[]>();
    for (const f of findings) {
      if (!byTitle.has(f.title)) byTitle.set(f.title, []);
      byTitle.get(f.title)!.push(f);
    }
    const titles = [...byTitle.keys()].sort((a, b) => a.localeCompare(b));
    for (const title of titles) {
      const list = byTitle.get(title)!;
      md += `## ${title} (${list.length})\n\n`;
      md += `${list[0].reasoning}\n\n`;
      for (const f of list.slice(0, 20)) {
        md += `- ${f.evidence[0]?.file}:${f.evidence[0]?.line} (confidence ${f.confidence}%)\n`;
      }
      if (list.length > 20) md += `- ...and ${list.length - 20} more\n`;
      md += `\n`;
    }
    return md;
  }

  async scan(context: ScanContext): Promise<Finding[]> {
    return this.analyze(context).findings;
  }

  async exportReport(context: ScanContext, format: 'json' | 'markdown'): Promise<string> {
    const analysis = this.analyze(context);
    return format === 'json' ? JSON.stringify(analysis.findings, null, 2) : analysis.report;
  }
}
