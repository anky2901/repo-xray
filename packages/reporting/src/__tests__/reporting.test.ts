import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateVulnReport } from '../vuln-report';
import { generateAdoptionReport } from '../adoption-report';
import { generateAutofixReport } from '../autofix-report';
import type { ScanResult, Finding } from '@repo-xray/types';

const root = path.join(__dirname, 'reporting-fixture');

function makeResult(findings: Finding[] = [], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    schema: '1.0',
    scanId: 'scan',
    repoId: 'repo',
    mode: 'deep',
    findings,
    scores: { overall: 80, security: 70, architecture: 90, maintainability: 80, testCoverage: 60, releaseReadiness: 75, dependency: 88 },
    meta: {
      name: 'demo-app',
      source: 'local',
      languages: { TypeScript: 100 },
      frameworks: ['Express'],
      packageManagers: ['npm'],
      totalFiles: 10,
      totalLines: 500,
      entrypoints: ['src/index.ts'],
      architectureStyle: 'Standard layout',
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
    ...overrides,
  };
}

function sqlFinding(): Finding {
  return {
    id: 'sec-sql-1',
    module: 'security',
    title: 'Potential SQL Injection',
    summary: 'string concat in query',
    severity: 'HIGH',
    confidence: 75,
    evidence: [{ file: 'src/db.ts', line: 47, snippet: 'db.query(...)' }],
    reasoning: 'SQL built via concatenation.',
    reproducible: true,
    tags: ['dangerous-pattern', 'sql-injection'],
  };
}

describe('generateVulnReport', () => {
  it('emits all six sections for a high-severity finding', () => {
    const { count, report } = generateVulnReport(makeResult([sqlFinding()]));
    expect(count).toBe(1);
    expect(report).toContain('Why vulnerable:');
    expect(report).toContain('Exploitability:');
    expect(report).toContain('Impact:');
    expect(report).toContain('Minimal Fix');
    expect(report).toContain('Best Practice Fix');
    expect(report).toContain('AI Fix Prompt');
    expect(report).toContain('Test Fix');
  });

  it('tailors guidance to the finding class', () => {
    const { report } = generateVulnReport(makeResult([sqlFinding()]));
    expect(report.toLowerCase()).toContain('parameteriz');
  });

  it('reports nothing to fix when there are no critical/high security findings', () => {
    const { count, report } = generateVulnReport(makeResult([]));
    expect(count).toBe(0);
    expect(report).toContain('No critical or high severity');
  });

  it('ignores low/medium and non-security findings', () => {
    const low: Finding = { ...sqlFinding(), id: 'x', severity: 'LOW' };
    const arch: Finding = { ...sqlFinding(), id: 'y', module: 'architecture', severity: 'HIGH' };
    const { count } = generateVulnReport(makeResult([low, arch]));
    expect(count).toBe(0);
  });

  it('tailors fixes for each security finding class', () => {
    const cases: { tags: string[]; title: string; expect: string }[] = [
      { tags: ['dangerous-pattern', 'xss'], title: 'XSS via innerHTML', expect: 'textContent' },
      { tags: ['dangerous-pattern', 'code-injection'], title: 'Dangerous Eval usage', expect: 'eval' },
      { tags: ['secret', 'credential'], title: 'Hardcoded OpenAI API Key', expect: 'process.env' },
      { tags: ['supply-chain', 'cve'], title: 'Vulnerable Dependency: lodash', expect: 'patched version' },
      { tags: ['config', 'cors'], title: 'Permissive CORS Configuration', expect: 'regression test' },
    ];
    for (const c of cases) {
      const finding: Finding = {
        id: `sec-${c.title}`,
        module: 'security',
        title: c.title,
        summary: 's',
        severity: 'HIGH',
        confidence: 80,
        evidence: [{ file: 'src/x.ts', line: 1 }],
        reasoning: 'reasoning text long enough',
        reproducible: true,
        tags: c.tags,
      };
      const { count, report } = generateVulnReport(makeResult([finding]));
      expect(count).toBe(1);
      expect(report.toLowerCase()).toContain(c.expect.toLowerCase());
    }
  });
});

describe('generateAdoptionReport', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('always shows a confidence interval below 100', () => {
    const { confidence, report } = generateAdoptionReport(root, makeResult());
    expect(confidence).toBeLessThan(100);
    expect(report).toContain('Confidence:');
    expect(report).toContain('Score Breakdown');
  });

  it('flags missing demo and examples as blockers', () => {
    const { report } = generateAdoptionReport(root, makeResult());
    expect(report).toContain('No demo gif or video');
    expect(report).toContain('No examples directory');
  });

  it('rewards a strong README and examples with higher confidence', () => {
    const weak = generateAdoptionReport(root, makeResult());

    fs.writeFileSync(
      path.join(root, 'README.md'),
      '# demo\n## Installation\nnpm install\n```\ncode\n```\n## License\nMIT\n![demo](demo.gif)\n## Contributing\nyes'
    );
    fs.mkdirSync(path.join(root, 'examples'), { recursive: true });
    fs.writeFileSync(path.join(root, 'CONTRIBUTING.md'), '# Contributing');
    const strong = generateAdoptionReport(root, makeResult());

    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  it('classifies a backend framework repo', () => {
    const { category } = generateAdoptionReport(root, makeResult());
    expect(category).toContain('Backend');
  });
});

describe('generateAutofixReport', () => {
  it('pairs actionable findings with concrete fixes, grouped by severity', () => {
    const findings: Finding[] = [
      { id: 'a', module: 'security', title: 'Hardcoded OpenAI API Key', summary: '', severity: 'CRITICAL', confidence: 96, evidence: [{ file: 'src/c.ts', line: 3 }], reasoning: 'secret found in source code here', reproducible: true, tags: ['secret'] },
      { id: 'b', module: 'dependency', title: 'Duplicate Dependency: ms', summary: '', severity: 'LOW', confidence: 85, evidence: [{ file: 'lockfile' }], reasoning: 'two versions resolved at once', reproducible: true, tags: ['dependency', 'duplicate'] },
    ];
    const { actionable, report } = generateAutofixReport(makeResult(findings));
    expect(actionable).toBe(2);
    expect(report).toContain('## CRITICAL (1)');
    expect(report).toContain('## LOW (1)');
    expect(report.toLowerCase()).toContain('environment variable');
    expect(report.toLowerCase()).toContain('deduplicate');
  });

  it('excludes INFO and non-reproducible findings', () => {
    const findings: Finding[] = [
      { id: 'i', module: 'security', title: 'Info', summary: '', severity: 'INFO', confidence: 30, evidence: [{ file: 'x' }], reasoning: 'low confidence note here', reproducible: true, tags: [] },
      { id: 'n', module: 'security', title: 'NotRepro', summary: '', severity: 'HIGH', confidence: 90, evidence: [{ file: 'x' }], reasoning: 'cannot reproduce this one', reproducible: false, tags: [] },
    ];
    const { actionable } = generateAutofixReport(makeResult(findings));
    expect(actionable).toBe(0);
  });

  it('reports nothing to fix for a clean scan', () => {
    const { actionable, report } = generateAutofixReport(makeResult([]));
    expect(actionable).toBe(0);
    expect(report).toContain('No actionable findings');
  });
});
