import * as fs from 'fs';
import * as path from 'path';
import type { ScanResult, Finding } from '@repo-xray/types';

export interface PromptFacts {
  name: string;
  stack: string;
  architecture: string;
  entrypoint: string;
  testCommand: string;
  namingConvention: string;
  keyFiles: string[];
  knownIssues: string[];
}

export interface PromptBundle {
  facts: PromptFacts;
  files: Record<string, string>;
}

function readPackageJson(workspace: string): Record<string, unknown> | null {
  const p = path.join(workspace, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function topLanguages(languages: Record<string, number>): string[] {
  return Object.entries(languages)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([lang]) => lang);
}

function deriveStack(result: ScanResult): string {
  const parts: string[] = [];
  if (result.meta.frameworks.length) parts.push(...result.meta.frameworks);
  const langs = topLanguages(result.meta.languages);
  if (langs.length) parts.push(...langs);
  if (result.meta.packageManagers.length) parts.push(result.meta.packageManagers[0]);
  const seen = new Set<string>();
  const unique = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return unique.length ? unique.join(' + ') : 'Unknown';
}

function deriveTestCommand(workspace: string, result: ScanResult): string {
  const pkg = readPackageJson(workspace);
  const scripts = pkg && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {};
  if (scripts.test) {
    const pm = result.meta.packageManagers.includes('pnpm')
      ? 'pnpm'
      : result.meta.packageManagers.includes('yarn')
        ? 'yarn'
        : 'npm';
    return `${pm} test`;
  }
  if (result.meta.packageManagers.includes('pip')) return 'pytest';
  if (result.meta.packageManagers.includes('cargo')) return 'cargo test';
  if (result.meta.packageManagers.includes('go')) return 'go test ./...';
  if (result.meta.packageManagers.includes('maven')) return 'mvn test';
  if (result.meta.packageManagers.includes('gradle')) return 'gradle test';
  return 'Not detected';
}

function deriveNamingConvention(result: ScanResult): string {
  const langs = topLanguages(result.meta.languages);
  const primary = langs[0] || '';
  if (primary === 'Python') return 'snake_case (PEP 8)';
  if (primary === 'Go') return 'MixedCaps / camelCase';
  if (primary === 'Rust') return 'snake_case items, CamelCase types';
  if (primary === 'TypeScript' || primary === 'JavaScript') return 'camelCase values, PascalCase types';
  return 'Match the surrounding code';
}

function knownIssueLines(findings: Finding[]): string[] {
  const ranked = [...findings].sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of ranked) {
    if (f.severity !== 'CRITICAL' && f.severity !== 'HIGH' && f.severity !== 'MEDIUM') continue;
    if (seen.has(f.title)) continue;
    seen.add(f.title);
    const where = f.evidence[0]?.file ? ` (${f.evidence[0].file})` : '';
    out.push(`[${f.severity}] ${f.title}${where}`);
    if (out.length >= 8) break;
  }
  return out;
}

export class XRayPromptGenerator {
  readonly id = 'prompts';
  readonly name = 'Prompt Generator';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  generate(workspace: string, result: ScanResult): PromptBundle {
    const entrypoint = result.meta.entrypoints && result.meta.entrypoints.length ? result.meta.entrypoints[0] : 'Not detected';
    const facts: PromptFacts = {
      name: result.meta.name,
      stack: deriveStack(result),
      architecture: result.meta.architectureStyle || 'Standard layout',
      entrypoint,
      testCommand: deriveTestCommand(workspace, result),
      namingConvention: deriveNamingConvention(result),
      keyFiles: (result.meta.entrypoints || []).slice(0, 10),
      knownIssues: knownIssueLines(result.findings),
    };

    const files: Record<string, string> = {
      'PROMPTS/dev.md': this.dev(facts),
      'PROMPTS/bugfix.md': this.bugfix(facts),
      'PROMPTS/feature.md': this.feature(facts),
      'PROMPTS/audit.md': this.audit(facts),
      'PROMPTS/onboarding.md': this.onboarding(facts),
    };

    return { facts, files };
  }

  private issuesBlock(facts: PromptFacts): string {
    return facts.knownIssues.length ? facts.knownIssues.map((i) => `- ${i}`).join('\n') : '- None detected by the scan';
  }

  private dev(f: PromptFacts): string {
    return `Project: ${f.name}
Stack: ${f.stack}
Architecture: ${f.architecture}
Entrypoint: ${f.entrypoint}

Known issues from the latest scan:
${this.issuesBlock(f)}

Understand this project fully before changing anything.
Follow existing patterns. Do not introduce new ones without justification.
Do not break public API surfaces, data schemas, or auth contracts.

Task: <fill this in>
`;
  }

  private bugfix(f: PromptFacts): string {
    return `Repo: ${f.name} | Stack: ${f.stack} | Test runner: ${f.testCommand}

Find the root cause before writing any code.
Make the minimum number of file changes. Preserve backward compatibility.
Run \`${f.testCommand}\` after the fix; existing tests must still pass.

Bug: <fill this in>
`;
  }

  private feature(f: PromptFacts): string {
    return `Add a feature using the existing architecture (${f.architecture}).
Naming conventions: ${f.namingConvention}
Do not introduce new dependencies without justification.
Update tests and follow the existing test patterns (\`${f.testCommand}\`).

Feature: <fill this in>
`;
  }

  private audit(f: PromptFacts): string {
    return `Audit ${f.name} for security, performance, and maintainability.

Issues already found by the scan (do not re-report these):
${this.issuesBlock(f)}

Find new issues only.

Focus: <fill this in>
`;
  }

  private onboarding(f: PromptFacts): string {
    const keyFiles = f.keyFiles.length ? f.keyFiles.map((k) => `- ${k}`).join('\n') : '- See the entrypoint above';
    return `Explain ${f.name} to a new engineer in five minutes.

Stack: ${f.stack}
Architecture: ${f.architecture}
Start here: ${f.entrypoint}
Test command: ${f.testCommand}

Key files:
${keyFiles}

Known gotchas from the scan:
${this.issuesBlock(f)}

Do not explain what the engineer can read in the README.
`;
  }
}
