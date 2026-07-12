import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';

export type CiProvider =
  | 'github-actions'
  | 'circleci'
  | 'jenkins'
  | 'travis'
  | 'azure-pipelines'
  | 'unknown';

export interface CiWorkflowSummary {
  file: string;
  parseable: boolean;
  runsTests: boolean;
  runsLint: boolean;
  runsBuild: boolean;
  runsSecurity: boolean;
}

export interface CiAnalysis {
  providers: CiProvider[];
  workflows: CiWorkflowSummary[];
  testsConfigured: boolean;
  findings: Finding[];
  report: string;
}

const TEST_COMMAND_PATTERNS = [
  /\bnpm\s+(run\s+)?test\b/,
  /\bpnpm\s+(run\s+)?test\b/,
  /\byarn\s+test\b/,
  /\bnpx\s+(vitest|jest|mocha|ava)\b/,
  /\b(vitest|jest|mocha|ava)\b/,
  /\bpytest\b/,
  /\bpython\s+-m\s+pytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\brspec\b/,
  /\bphpunit\b/,
];

const LINT_COMMAND_PATTERNS = [/\beslint\b/, /\blint\b/, /\bruff\b/, /\bflake8\b/, /\bclippy\b/, /\bprettier\b/];
const BUILD_COMMAND_PATTERNS = [/\b(npm|pnpm|yarn)\s+(run\s+)?build\b/, /\btsc\b/, /\bgo\s+build\b/, /\bcargo\s+build\b/, /\bmake\b/];
const SECURITY_COMMAND_PATTERNS = [/\b(npm|pnpm|yarn)\s+audit\b/, /\bsnyk\b/, /\btrivy\b/, /\bcodeql\b/, /\bbandit\b/, /\bgitleaks\b/];

const SECRET_KEY_HINT = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const GITHUB_EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const SHA_PIN = /^[0-9a-f]{40}$/;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function listWorkflowFiles(workspacePath: string): string[] {
  const dir = path.join(workspacePath, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

function detectProviders(workspacePath: string): CiProvider[] {
  const providers: CiProvider[] = [];
  if (listWorkflowFiles(workspacePath).length > 0) providers.push('github-actions');
  if (fs.existsSync(path.join(workspacePath, '.circleci', 'config.yml'))) providers.push('circleci');
  if (fs.existsSync(path.join(workspacePath, 'Jenkinsfile'))) providers.push('jenkins');
  if (fs.existsSync(path.join(workspacePath, '.travis.yml'))) providers.push('travis');
  if (
    fs.existsSync(path.join(workspacePath, 'azure-pipelines.yml')) ||
    fs.existsSync(path.join(workspacePath, 'azure-pipelines.yaml'))
  ) {
    providers.push('azure-pipelines');
  }
  return providers;
}

export class XRayCiAnalyzer implements Analyzer {
  readonly id = 'ci-health';
  readonly name = 'CI/CD Health';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): CiAnalysis {
    const workspace = context.workspacePath;
    const providers = detectProviders(workspace);
    const workflowFiles = listWorkflowFiles(workspace);
    const findings: Finding[] = [];
    const workflows: CiWorkflowSummary[] = [];

    context.logger.info(`[M18:ci] Detected providers: ${providers.join(', ') || 'none'} (${workflowFiles.length} workflows)`);

    for (const file of workflowFiles) {
      const rel = path.relative(workspace, file).replace(/\\/g, '/');
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      let parseable = true;
      try {
        parseYaml(raw);
      } catch (err: unknown) {
        parseable = false;
        context.logger.warn(`[M18:ci] Malformed workflow YAML in ${rel}: ${(err as Error).message}`);
        findings.push({
          id: `ci-malformed-${rel.replace(/[^a-zA-Z0-9]/g, '-')}`,
          module: 'ci-health',
          title: 'Malformed Workflow YAML',
          summary: `Workflow "${rel}" could not be parsed as valid YAML.`,
          severity: 'LOW',
          confidence: 95,
          evidence: [{ file: rel, line: 1 }],
          reasoning: 'The workflow file is not valid YAML, so GitHub Actions will fail to schedule it. Continuous integration for this pipeline is effectively disabled until the syntax is fixed.',
          reproducible: true,
          tags: ['ci', 'yaml'],
        });
      }

      const summary = this.scanWorkflow(rel, raw, findings);
      summary.parseable = parseable;
      workflows.push(summary);
    }

    const testsConfigured = workflows.some((w) => w.runsTests);

    if (providers.includes('github-actions') && workflowFiles.length > 0 && !testsConfigured) {
      findings.push({
        id: 'ci-no-tests',
        module: 'ci-health',
        title: 'CI Does Not Run Tests',
        summary: 'No GitHub Actions workflow runs an automated test command.',
        severity: 'HIGH',
        confidence: 85,
        evidence: [{ file: '.github/workflows', line: 1 }],
        reasoning: 'None of the configured workflows invoke a recognized test runner. Without automated tests in CI, regressions can merge undetected and release readiness drops sharply.',
        reproducible: true,
        tags: ['ci', 'testing'],
      });
    }

    const report = this.buildReport(providers, workflows, findings, testsConfigured);

    return { providers, workflows, testsConfigured, findings, report };
  }

  private scanWorkflow(rel: string, raw: string, findings: Finding[]): CiWorkflowSummary {
    const lines = raw.split(/\r?\n/);
    const summary: CiWorkflowSummary = {
      file: rel,
      parseable: true,
      runsTests: false,
      runsLint: false,
      runsBuild: false,
      runsSecurity: false,
    };

    let hasJobs = false;
    let hasTimeout = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^jobs\s*:/.test(trimmed)) hasJobs = true;
      if (/timeout-minutes\s*:/.test(trimmed)) hasTimeout = true;

      if (matchesAny(line, TEST_COMMAND_PATTERNS)) summary.runsTests = true;
      if (matchesAny(line, LINT_COMMAND_PATTERNS)) summary.runsLint = true;
      if (matchesAny(line, BUILD_COMMAND_PATTERNS)) summary.runsBuild = true;
      if (matchesAny(line, SECURITY_COMMAND_PATTERNS)) summary.runsSecurity = true;

      const usesMatch = trimmed.match(/^-?\s*uses\s*:\s*([^\s#]+)/);
      if (usesMatch) {
        const ref = usesMatch[1];
        const atIdx = ref.lastIndexOf('@');
        if (atIdx > -1) {
          const version = ref.slice(atIdx + 1);
          const isLocal = ref.startsWith('./') || ref.startsWith('../');
          if (!isLocal && !SHA_PIN.test(version)) {
            findings.push({
              id: `ci-unpinned-${rel.replace(/[^a-zA-Z0-9]/g, '-')}-${i + 1}`,
              module: 'ci-health',
              title: 'Unpinned GitHub Action',
              summary: `Action "${ref}" is pinned to a mutable ref instead of a commit SHA.`,
              severity: 'MEDIUM',
              confidence: 90,
              evidence: [{ file: rel, line: i + 1, snippet: trimmed }],
              reasoning: 'Referencing an action by tag or branch lets the upstream maintainer change the code that runs in your pipeline. Pinning to a full commit SHA prevents a compromised or retagged release from executing with your repository permissions.',
              reproducible: true,
              tags: ['ci', 'supply-chain'],
            });
          }
        }
      }

      if (/permissions\s*:\s*write-all/.test(trimmed)) {
        findings.push({
          id: `ci-permissions-${rel.replace(/[^a-zA-Z0-9]/g, '-')}-${i + 1}`,
          module: 'ci-health',
          title: 'Overly Permissive Workflow Permissions',
          summary: `Workflow "${rel}" grants write-all permissions to the GITHUB_TOKEN.`,
          severity: 'MEDIUM',
          confidence: 90,
          evidence: [{ file: rel, line: i + 1, snippet: trimmed }],
          reasoning: 'write-all gives the workflow token write access to every scope. A compromised dependency or action could then push code, alter releases, or modify issues. Grant only the minimum permissions each job needs.',
          reproducible: true,
          tags: ['ci', 'least-privilege'],
        });
      }

      const envMatch = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
      if (envMatch) {
        const key = envMatch[1];
        let value = envMatch[2].trim();
        const quoted = /^["'].*["']$/.test(value);
        if (quoted) value = value.slice(1, -1);
        if (
          SECRET_KEY_HINT.test(key) &&
          value.length >= 8 &&
          !GITHUB_EXPRESSION.test(value) &&
          !/^(true|false|null|\d+)$/i.test(value)
        ) {
          findings.push({
            id: `ci-secret-${rel.replace(/[^a-zA-Z0-9]/g, '-')}-${i + 1}`,
            module: 'ci-health',
            title: 'Hardcoded Secret in Workflow',
            summary: `Workflow "${rel}" assigns a literal value to "${key}" instead of a secrets reference.`,
            severity: 'CRITICAL',
            confidence: 80,
            evidence: [{ file: rel, line: i + 1, snippet: `${key}: [REDACTED]` }],
            reasoning: 'Secret-looking values committed directly into a workflow are exposed in version control and build logs. Reference repository secrets via the ${{ secrets.NAME }} syntax so the value is injected at runtime and never stored in the file.',
            reproducible: true,
            tags: ['ci', 'secret'],
          });
        }
      }
    }

    if (hasJobs && !hasTimeout) {
      findings.push({
        id: `ci-timeout-${rel.replace(/[^a-zA-Z0-9]/g, '-')}`,
        module: 'ci-health',
        title: 'Workflow Job Missing Timeout',
        summary: `Workflow "${rel}" defines jobs without a timeout-minutes limit.`,
        severity: 'LOW',
        confidence: 70,
        evidence: [{ file: rel, line: 1 }],
        reasoning: 'A job without timeout-minutes can hang until the platform maximum (often 6 hours), wasting runner minutes and delaying feedback. Setting an explicit timeout fails stuck jobs fast.',
        reproducible: true,
        tags: ['ci', 'reliability'],
      });
    }

    return summary;
  }

  private buildReport(
    providers: CiProvider[],
    workflows: CiWorkflowSummary[],
    findings: Finding[],
    testsConfigured: boolean
  ): string {
    const bySeverity = (sev: string): number => findings.filter((f) => f.severity === sev).length;

    let md = `# CI/CD Health Report\n\n`;
    md += `Providers detected: ${providers.length ? providers.join(', ') : 'none'}\n`;
    md += `Workflows analyzed: ${workflows.length}\n`;
    md += `Tests configured in CI: ${testsConfigured ? 'yes' : 'no'}\n`;
    md += `Findings: ${findings.length} (${bySeverity('CRITICAL')} CRITICAL, ${bySeverity('HIGH')} HIGH, ${bySeverity('MEDIUM')} MEDIUM, ${bySeverity('LOW')} LOW)\n\n`;

    if (workflows.length > 0) {
      md += `## Workflow Coverage\n\n`;
      md += `| Workflow | Parseable | Tests | Lint | Build | Security |\n`;
      md += `|---|---|---|---|---|---|\n`;
      for (const w of workflows) {
        md += `| ${w.file} | ${w.parseable ? 'yes' : 'no'} | ${w.runsTests ? 'yes' : 'no'} | ${w.runsLint ? 'yes' : 'no'} | ${w.runsBuild ? 'yes' : 'no'} | ${w.runsSecurity ? 'yes' : 'no'} |\n`;
      }
      md += `\n`;
    }

    md += `## Findings\n\n`;
    if (findings.length === 0) {
      if (providers.length === 0) {
        md += `*No CI configuration detected. Consider adding a workflow that runs tests, lint, and build on every push.*\n`;
      } else {
        md += `*No CI health issues detected. Pipeline configuration looks solid.*\n`;
      }
    } else {
      const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
      const sorted = [...findings].sort((a, b) => {
        const s = order.indexOf(a.severity) - order.indexOf(b.severity);
        return s !== 0 ? s : a.id.localeCompare(b.id);
      });
      for (const f of sorted) {
        md += `### [${f.severity}] ${f.title}\n`;
        md += `- **Where:** ${f.evidence[0]?.file ?? 'n/a'}${f.evidence[0]?.line ? ` (line ${f.evidence[0].line})` : ''}\n`;
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
