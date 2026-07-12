import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';

export interface TestIntelligence {
  sourceFiles: number;
  testFiles: number;
  coveragePercent: number | null;
  coverageEstimated: boolean;
  unitTests: number;
  integrationTests: number;
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

function isTestFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    base.endsWith('_test.go') ||
    /(^|\/)(tests?|__tests__|spec)\//.test(rel.toLowerCase())
  );
}

function walkSource(dir: string, workspace: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
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
      walkSource(full, workspace, out);
    } else if (entry.isFile() && SOURCE_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      out.push(path.relative(workspace, full).replace(/\\/g, '/'));
    }
  }
}

function parseCoverage(workspace: string): number | null {
  // coverage-summary.json (Istanbul/nyc)
  const candidates = [
    path.join(workspace, 'coverage', 'coverage-summary.json'),
    path.join(workspace, 'coverage-summary.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const pct = json.total?.lines?.pct;
        if (typeof pct === 'number') return Math.round(pct);
      } catch {
        /* ignore */
      }
    }
  }

  // lcov.info — compute line coverage from LF/LH counters.
  const lcovCandidates = [path.join(workspace, 'coverage', 'lcov.info'), path.join(workspace, 'lcov.info')];
  for (const file of lcovCandidates) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        let found = 0;
        let hit = 0;
        for (const line of content.split(/\r?\n/)) {
          if (line.startsWith('LF:')) found += parseInt(line.slice(3), 10) || 0;
          else if (line.startsWith('LH:')) hit += parseInt(line.slice(3), 10) || 0;
        }
        if (found > 0) return Math.round((hit / found) * 100);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

const FLAKY_PATTERNS: { regex: RegExp; label: string; timerSensitive: boolean; reason: string; fix: string }[] = [
  {
    regex: /\b(Date\.now\(\)|new Date\()/,
    label: 'Time-dependent assertion',
    timerSensitive: true,
    reason: 'Reading the real clock inside a test makes results depend on when they run, producing intermittent failures around boundaries (midnight, month rollover, timezone shifts).',
    fix: 'Use fake timers (vi.useFakeTimers() / jest.useFakeTimers()) and set a fixed system time before assertions.',
  },
  {
    regex: /setTimeout\s*\(/,
    label: 'Real setTimeout in test',
    timerSensitive: true,
    reason: 'Relying on real timers introduces wall-clock waits that race with assertions on slower or busy CI runners.',
    fix: 'Replace real waits with fake timers and advance them deterministically (vi.advanceTimersByTime).',
  },
  {
    regex: /\b(fetch\s*\(|axios\.(get|post|put|delete|patch)\s*\()/,
    label: 'Unmocked network call',
    timerSensitive: false,
    reason: 'Hitting a live network inside a unit test couples correctness to an external service that can be slow, rate-limited, or offline.',
    fix: 'Mock the HTTP client (vi.mock / msw) so the test exercises only your code.',
  },
];

export class XRayTestingAnalyzer implements Analyzer {
  readonly id = 'test-intelligence';
  readonly name = 'Test Intelligence';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): TestIntelligence {
    const workspace = context.workspacePath;
    const findings: Finding[] = [];

    const all: string[] = [];
    walkSource(workspace, workspace, all);

    const testFilesList = all.filter(isTestFile);
    const sourceFilesList = all.filter((f) => !isTestFile(f));

    const integrationTests = testFilesList.filter((f) => /integration|e2e|\.int\./i.test(f)).length;
    const unitTests = testFilesList.length - integrationTests;

    context.logger.info(`[M15:testing] ${sourceFilesList.length} source files, ${testFilesList.length} test files`);

    let coveragePercent = parseCoverage(workspace);
    let coverageEstimated = false;
    if (coveragePercent === null && sourceFilesList.length > 0) {
      coverageEstimated = true;
      coveragePercent = Math.min(100, Math.round((testFilesList.length / sourceFilesList.length) * 100));
    }

    if (sourceFilesList.length >= 3 && testFilesList.length === 0) {
      findings.push({
        id: 'test-none',
        module: 'test-intelligence',
        title: 'No Test Files Detected',
        summary: `Found ${sourceFilesList.length} source files but no test files.`,
        severity: 'MEDIUM',
        confidence: 70,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'A codebase without any automated tests has no safety net against regressions. Even a small suite covering the most-imported modules sharply reduces the risk of shipping breaking changes.',
        reproducible: true,
        tags: ['testing', 'coverage'],
      });
    }

    if (coveragePercent !== null && coveragePercent < 50 && sourceFilesList.length >= 3) {
      findings.push({
        id: 'test-low-coverage',
        module: 'test-intelligence',
        title: 'Low Test Coverage',
        summary: `${coverageEstimated ? 'Estimated' : 'Measured'} test coverage is ${coveragePercent}%.`,
        severity: 'LOW',
        confidence: coverageEstimated ? 55 : 80,
        evidence: [{ file: coverageEstimated ? '.' : 'coverage', line: 1 }],
        reasoning: `${coverageEstimated ? 'Based on the ratio of test files to source files, coverage appears low.' : 'Measured line coverage is below 50%.'} Modules without tests are the most likely place for undetected regressions. Prioritize tests for the most-imported files first.`,
        reproducible: true,
        tags: ['testing', 'coverage'],
      });
    }

    if (testFilesList.length >= 5) {
      const unitRatio = unitTests / testFilesList.length;
      if (unitRatio > 0.9 && integrationTests === 0) {
        findings.push({
          id: 'test-no-integration',
          module: 'test-intelligence',
          title: 'Missing Integration Tests',
          summary: `${testFilesList.length} test files are essentially all unit tests with no integration coverage.`,
          severity: 'LOW',
          confidence: 55,
          evidence: [{ file: '.', line: 1 }],
          reasoning: 'A suite that is almost entirely unit tests can pass while components fail to work together. A few integration tests across module boundaries catch wiring and contract mismatches that unit tests miss.',
          reproducible: true,
          tags: ['testing', 'balance'],
        });
      }
    }

    this.scanFlakyPatterns(workspace, testFilesList, findings);

    const report = this.buildReport(sourceFilesList.length, testFilesList.length, coveragePercent, coverageEstimated, unitTests, integrationTests, findings);

    return {
      sourceFiles: sourceFilesList.length,
      testFiles: testFilesList.length,
      coveragePercent,
      coverageEstimated,
      unitTests,
      integrationTests,
      findings,
      report,
    };
  }

  private scanFlakyPatterns(workspace: string, testFiles: string[], findings: Finding[]): void {
    for (const rel of testFiles) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(workspace, rel), 'utf-8');
      } catch {
        continue;
      }
      const hasFakeTimers = /useFakeTimers|sinon\.useFakeTimers/.test(content);
      const lines = content.split(/\r?\n/);
      const seen = new Set<string>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pat of FLAKY_PATTERNS) {
          if (!pat.regex.test(line)) continue;
          if (pat.timerSensitive && hasFakeTimers) continue;
          if (seen.has(pat.label)) continue;
          seen.add(pat.label);
          findings.push({
            id: `test-flaky-${rel.replace(/[^a-zA-Z0-9]/g, '-')}-${pat.label.replace(/[^a-zA-Z0-9]/g, '-')}`,
            module: 'test-intelligence',
            title: `Flaky Test Pattern: ${pat.label}`,
            summary: `"${rel}" contains a pattern associated with intermittent test failures (${pat.label}).`,
            severity: 'LOW',
            confidence: 60,
            evidence: [{ file: rel, line: i + 1, snippet: line.trim().slice(0, 200) }],
            reasoning: `${pat.reason} ${pat.fix}`,
            reproducible: true,
            tags: ['testing', 'flaky'],
          });
        }
      }
    }
  }

  private buildReport(
    sourceFiles: number,
    testFiles: number,
    coveragePercent: number | null,
    coverageEstimated: boolean,
    unitTests: number,
    integrationTests: number,
    findings: Finding[]
  ): string {
    let md = `# Test Intelligence Report\n\n`;
    md += `Source files: ${sourceFiles}\n`;
    md += `Test files: ${testFiles} (${unitTests} unit, ${integrationTests} integration/e2e)\n`;
    if (coveragePercent !== null) {
      md += `Coverage: ${coveragePercent}%${coverageEstimated ? ' (estimated from file ratio, confidence 55%)' : ' (measured)'}\n`;
    } else {
      md += `Coverage: unknown\n`;
    }
    md += `\n## Prioritized Gaps & Risks\n\n`;

    if (findings.length === 0) {
      md += `*No significant testing gaps or flaky patterns detected.*\n`;
      return md;
    }

    const order = ['MEDIUM', 'LOW', 'INFO'];
    const sorted = [...findings].sort((a, b) => {
      const s = order.indexOf(a.severity) - order.indexOf(b.severity);
      return s !== 0 ? s : a.id.localeCompare(b.id);
    });
    for (const f of sorted) {
      md += `### [${f.severity}] ${f.title}\n`;
      md += `- **Summary:** ${f.summary}\n`;
      md += `- **Confidence:** ${f.confidence}%\n`;
      if (f.evidence[0]?.snippet) md += `- **Evidence:** \`${f.evidence[0].snippet}\`\n`;
      md += `- **Suggested action:** ${f.reasoning}\n\n`;
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
