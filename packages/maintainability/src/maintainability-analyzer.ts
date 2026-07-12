import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';

export interface FileMetric {
  file: string;
  lines: number;
  complexity: number;
  functions: number;
  commentRatio: number;
}

export interface MaintainabilityAnalysis {
  filesAnalyzed: number;
  avgComplexity: number;
  totalLines: number;
  commentRatio: number;
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

const DECISION_PATTERNS = [
  /\bif\b/g,
  /\belse\s+if\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /&&/g,
  /\|\|/g,
  /\?\?/g,
  /\?[^.:]/g,
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

export function estimateComplexity(source: string): number {
  let complexity = 1;
  for (const pat of DECISION_PATTERNS) {
    pat.lastIndex = 0;
    const matches = source.match(pat);
    if (matches) complexity += matches.length;
  }
  return complexity;
}

function countFunctions(source: string): number {
  const patterns = [
    /\bfunction\b/g,
    /=>/g,
    /\bdef\s+\w+/g,
    /\bfunc\s+\w+/g,
    /\bfn\s+\w+/g,
  ];
  let count = 0;
  for (const p of patterns) {
    const m = source.match(p);
    if (m) count += m.length;
  }
  return count;
}

function countCommentLines(source: string, ext: string): number {
  const lines = source.split(/\r?\n/);
  let comments = 0;
  let inBlock = false;
  const hashLang = ext === '.py' || ext === '.rb' || ext === '.sh';
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      comments++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//') || (hashLang && line.startsWith('#'))) {
      comments++;
    } else if (line.startsWith('/*')) {
      comments++;
      if (!line.includes('*/')) inBlock = true;
    }
  }
  return comments;
}

export class XRayMaintainabilityAnalyzer implements Analyzer {
  readonly id = 'maintainability';
  readonly name = 'Maintainability X-Ray';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): MaintainabilityAnalysis {
    const workspace = context.workspacePath;
    const findings: Finding[] = [];
    const rels: string[] = [];
    walk(workspace, workspace, rels);
    const sourceFiles = rels.filter((r) => !isTestFile(r)).sort((a, b) => a.localeCompare(b));

    context.logger.info(`[M5:maintainability] Analyzing ${sourceFiles.length} source files`);

    const metrics: FileMetric[] = [];
    let totalLines = 0;
    let totalCommentLines = 0;

    for (const rel of sourceFiles) {
      let source = '';
      try {
        source = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      } catch {
        continue;
      }
      const ext = path.extname(rel).toLowerCase();
      const lines = source.split(/\r?\n/).length;
      const complexity = estimateComplexity(source);
      const functions = countFunctions(source);
      const commentLines = countCommentLines(source, ext);
      const commentRatio = lines > 0 ? commentLines / lines : 0;

      totalLines += lines;
      totalCommentLines += commentLines;
      metrics.push({ file: rel, lines, complexity, functions, commentRatio });
    }

    for (const m of metrics) {
      if (m.lines > 400) {
        findings.push({
          id: `maint-longfile-${m.file.replace(/[^a-zA-Z0-9]/g, '-')}`,
          module: 'maintainability',
          title: 'Long File',
          summary: `"${m.file}" has ${m.lines} lines.`,
          severity: m.lines > 800 ? 'MEDIUM' : 'LOW',
          confidence: 80,
          evidence: [{ file: m.file, line: 1, snippet: `${m.lines} lines` }],
          reasoning: 'Files over a few hundred lines tend to hold multiple responsibilities, which slows comprehension and raises the risk of merge conflicts. Splitting along cohesive boundaries keeps each unit easy to reason about.',
          reproducible: true,
          tags: ['maintainability', 'size'],
        });
      }

      const density = m.functions > 0 ? m.complexity / m.functions : m.complexity;
      if (m.complexity > 60 && density > 8) {
        findings.push({
          id: `maint-complex-${m.file.replace(/[^a-zA-Z0-9]/g, '-')}`,
          module: 'maintainability',
          title: 'High Cyclomatic Complexity',
          summary: `"${m.file}" has an estimated complexity of ${m.complexity} across ${m.functions} functions.`,
          severity: m.complexity > 120 ? 'MEDIUM' : 'LOW',
          confidence: 60,
          evidence: [{ file: m.file, line: 1, snippet: `complexity ~${m.complexity}, functions ${m.functions}` }],
          reasoning: 'A high density of decision points per function makes code paths hard to test exhaustively and easy to break. Extracting helpers and flattening nested conditionals lowers the branching a reader must track.',
          reproducible: true,
          tags: ['maintainability', 'complexity'],
        });
      }
    }

    const avgComplexity = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.complexity, 0) / metrics.length) : 0;
    const commentRatio = totalLines > 0 ? totalCommentLines / totalLines : 0;

    if (metrics.length >= 5 && commentRatio < 0.02) {
      findings.push({
        id: 'maint-low-docs',
        module: 'maintainability',
        title: 'Low Documentation Density',
        summary: `Comment lines are ${(commentRatio * 100).toFixed(1)}% of the codebase.`,
        severity: 'LOW',
        confidence: 50,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Very sparse commenting can slow onboarding for non-obvious logic. This is a soft signal: self-explanatory code needs few comments, so weigh it against the complexity findings rather than as an absolute.',
        reproducible: true,
        tags: ['maintainability', 'documentation'],
      });
    }

    const score = this.computeScore(findings, avgComplexity);
    const report = this.buildReport(metrics, avgComplexity, totalLines, commentRatio, findings, score);

    context.logger.info(`[M5:maintainability] Completed — ${findings.length} findings, score ${score}`);
    return {
      filesAnalyzed: metrics.length,
      avgComplexity,
      totalLines,
      commentRatio,
      score,
      findings,
      report,
    };
  }

  private computeScore(findings: Finding[], avgComplexity: number): number {
    let score = 100;
    for (const f of findings) {
      if (f.severity === 'MEDIUM') score -= 6;
      else if (f.severity === 'LOW') score -= 2;
    }
    if (avgComplexity > 40) score -= 10;
    else if (avgComplexity > 20) score -= 5;
    return Math.max(0, Math.min(100, score));
  }

  private buildReport(
    metrics: FileMetric[],
    avgComplexity: number,
    totalLines: number,
    commentRatio: number,
    findings: Finding[],
    score: number
  ): string {
    let md = `# Maintainability Report\n\n`;
    md += `Maintainability Score: ${score}/100\n`;
    md += `Files analyzed: ${metrics.length}\n`;
    md += `Total lines: ${totalLines}\n`;
    md += `Average complexity per file: ${avgComplexity}\n`;
    md += `Comment density: ${(commentRatio * 100).toFixed(1)}%\n\n`;

    const hotspots = [...metrics].sort((a, b) => b.complexity - a.complexity).slice(0, 10);
    if (hotspots.length) {
      md += `## Complexity Hotspots\n\n`;
      md += `| File | Lines | Complexity | Functions |\n|---|---|---|---|\n`;
      for (const h of hotspots) {
        md += `| ${h.file} | ${h.lines} | ${h.complexity} | ${h.functions} |\n`;
      }
      md += `\n`;
    }

    md += `## Findings\n\n`;
    if (findings.length === 0) {
      md += `*No maintainability concerns detected.*\n`;
    } else {
      const order = ['MEDIUM', 'LOW', 'INFO'];
      const sorted = [...findings].sort((a, b) => {
        const s = order.indexOf(a.severity) - order.indexOf(b.severity);
        return s !== 0 ? s : a.id.localeCompare(b.id);
      });
      for (const f of sorted) {
        md += `### [${f.severity}] ${f.title}\n`;
        md += `- **Summary:** ${f.summary}\n`;
        md += `- **Confidence:** ${f.confidence}%\n`;
        md += `- **Why:** ${f.reasoning}\n\n`;
      }
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
