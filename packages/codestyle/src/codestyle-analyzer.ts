import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';

export interface StyleStats {
  filesAnalyzed: number;
  indentStyle: 'spaces' | 'tabs' | 'mixed' | 'none';
  quoteStyle: 'single' | 'double' | 'mixed' | 'none';
  filesWithTrailingWhitespace: number;
  longLineFiles: number;
}

export interface CodeStyleAnalysis {
  stats: StyleStats;
  score: number;
  findings: Finding[];
  report: string;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
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
const MAX_LINE = 120;

function isTestFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base.includes('.test.') ||
    base.includes('.spec.') ||
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
    } else if (entry.isFile() && JS_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(workspace, full).replace(/\\/g, '/'));
    }
  }
}

export class XRayCodeStyleAnalyzer implements Analyzer {
  readonly id = 'code-style';
  readonly name = 'Code Style X-Ray';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): CodeStyleAnalysis {
    const workspace = context.workspacePath;
    const findings: Finding[] = [];
    const rels: string[] = [];
    walk(workspace, workspace, rels);
    const files = rels.filter((r) => !isTestFile(r)).sort((a, b) => a.localeCompare(b));

    context.logger.info(`[M4:code-style] Analyzing ${files.length} files`);

    let tabIndentFiles = 0;
    let spaceIndentFiles = 0;
    let singleQuoteFiles = 0;
    let doubleQuoteFiles = 0;
    let filesWithTrailingWhitespace = 0;
    let longLineFiles = 0;

    for (const rel of files) {
      let source = '';
      try {
        source = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      } catch {
        continue;
      }
      const lines = source.split(/\r?\n/);

      let tabIndents = 0;
      let spaceIndents = 0;
      let single = 0;
      let double = 0;
      let trailing = false;
      let longLine = false;

      for (const line of lines) {
        if (/^\t+/.test(line)) tabIndents++;
        else if (/^ {2,}/.test(line)) spaceIndents++;
        if (/[ \t]+$/.test(line)) trailing = true;
        if (line.length > MAX_LINE) longLine = true;
        const sq = (line.match(/'/g) || []).length;
        const dq = (line.match(/"/g) || []).length;
        single += sq;
        double += dq;
      }

      if (tabIndents > spaceIndents) tabIndentFiles++;
      else if (spaceIndents > 0) spaceIndentFiles++;
      if (single > double) singleQuoteFiles++;
      else if (double > single) doubleQuoteFiles++;
      if (trailing) filesWithTrailingWhitespace++;
      if (longLine) longLineFiles++;
    }

    const indentStyle: StyleStats['indentStyle'] =
      tabIndentFiles && spaceIndentFiles ? 'mixed' : tabIndentFiles ? 'tabs' : spaceIndentFiles ? 'spaces' : 'none';
    const quoteStyle: StyleStats['quoteStyle'] =
      singleQuoteFiles && doubleQuoteFiles ? 'mixed' : singleQuoteFiles ? 'single' : doubleQuoteFiles ? 'double' : 'none';

    if (files.length >= 5 && indentStyle === 'mixed') {
      findings.push({
        id: 'style-mixed-indent',
        module: 'code-style',
        title: 'Mixed Indentation Style',
        summary: `${tabIndentFiles} files lead with tabs, ${spaceIndentFiles} with spaces.`,
        severity: 'LOW',
        confidence: 70,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Mixing tabs and spaces across files causes noisy diffs and inconsistent rendering. Adopt one style and enforce it with an editorconfig and a formatter.',
        reproducible: true,
        tags: ['code-style', 'indentation'],
      });
    }

    if (files.length >= 5 && quoteStyle === 'mixed') {
      findings.push({
        id: 'style-mixed-quotes',
        module: 'code-style',
        title: 'Inconsistent Quote Style',
        summary: `${singleQuoteFiles} files favor single quotes, ${doubleQuoteFiles} double.`,
        severity: 'LOW',
        confidence: 55,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Inconsistent quote characters add churn to diffs. A formatter (Prettier) normalizes this automatically so reviewers focus on logic.',
        reproducible: true,
        tags: ['code-style', 'quotes'],
      });
    }

    if (filesWithTrailingWhitespace > 0) {
      findings.push({
        id: 'style-trailing-whitespace',
        module: 'code-style',
        title: 'Trailing Whitespace',
        summary: `${filesWithTrailingWhitespace} file(s) contain trailing whitespace.`,
        severity: 'LOW',
        confidence: 80,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Trailing whitespace produces spurious diff lines and can break some tooling. Enable trim-on-save or a lint rule to remove it.',
        reproducible: true,
        tags: ['code-style', 'whitespace'],
      });
    }

    if (longLineFiles > 0) {
      findings.push({
        id: 'style-long-lines',
        module: 'code-style',
        title: 'Long Lines',
        summary: `${longLineFiles} file(s) have lines longer than ${MAX_LINE} characters.`,
        severity: 'LOW',
        confidence: 50,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Very long lines are hard to read in side-by-side diffs and narrow editors. A print-width setting in the formatter keeps lines within a comfortable bound.',
        reproducible: true,
        tags: ['code-style', 'line-length'],
      });
    }

    const stats: StyleStats = {
      filesAnalyzed: files.length,
      indentStyle,
      quoteStyle,
      filesWithTrailingWhitespace,
      longLineFiles,
    };

    let score = 100;
    for (const f of findings) score -= f.severity === 'MEDIUM' ? 6 : 3;
    score = Math.max(0, Math.min(100, score));

    const report = this.buildReport(stats, findings, score);
    context.logger.info(`[M4:code-style] Completed — ${findings.length} findings, score ${score}`);
    return { stats, score, findings, report };
  }

  private buildReport(stats: StyleStats, findings: Finding[], score: number): string {
    let md = `# Code Style Report\n\n`;
    md += `Code Style Score: ${score}/100\n`;
    md += `Files analyzed: ${stats.filesAnalyzed}\n`;
    md += `Indentation: ${stats.indentStyle}\n`;
    md += `Quote style: ${stats.quoteStyle}\n\n`;
    md += `## Findings\n\n`;
    if (findings.length === 0) {
      md += `*No code style inconsistencies detected.*\n`;
    } else {
      for (const f of [...findings].sort((a, b) => a.id.localeCompare(b.id))) {
        md += `### [${f.severity}] ${f.title}\n`;
        md += `- **Summary:** ${f.summary}\n`;
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
