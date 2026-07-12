import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';
import { scoreReadme, ReadmeScore } from './readme-score';

export interface ReleaseCheck {
  label: string;
  points: number;
  earned: number;
  detail: string;
}

export interface ReleaseAnalysis {
  score: number;
  readmeScore: ReadmeScore;
  ciTestsConfigured: boolean;
  checks: ReleaseCheck[];
  blockers: string[];
  findings: Finding[];
  report: string;
  checklist: string;
}

const SPDX_HINT = /\b(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|GPL-3\.0|GPL-2\.0|LGPL-3\.0|MPL-2\.0|Unlicense|AGPL-3\.0)\b/i;

function exists(workspace: string, ...names: string[]): boolean {
  return names.some((n) => fs.existsSync(path.join(workspace, n)));
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

function hasLicense(workspace: string): { present: boolean; recognized: boolean; detail: string } {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    /* ignore */
  }
  const licenseFile = entries.find((e) => /^licen[sc]e(\.|$)/i.test(e));
  const pkg = readPackageJson(workspace);
  const pkgLicense = pkg && typeof pkg.license === 'string' ? (pkg.license as string) : '';

  let text = '';
  if (licenseFile) {
    try {
      text = fs.readFileSync(path.join(workspace, licenseFile), 'utf-8');
    } catch {
      /* ignore */
    }
  }
  const present = Boolean(licenseFile || pkgLicense);
  const recognized = SPDX_HINT.test(pkgLicense) || SPDX_HINT.test(text);
  const detail = present
    ? `License ${recognized ? 'recognized as SPDX' : 'present but SPDX identifier not recognized'} (${pkgLicense || licenseFile})`
    : 'No LICENSE file or package.json license field';
  return { present, recognized, detail };
}

function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

export class XRayReleaseAnalyzer implements Analyzer {
  readonly id = 'release';
  readonly name = 'Release Readiness';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext, ciTestsConfigured?: boolean): ReleaseAnalysis {
    const workspace = context.workspacePath;
    const findings: Finding[] = [];
    const checks: ReleaseCheck[] = [];
    const blockers: string[] = [];

    const license = hasLicense(workspace);
    const licensePts = license.present ? (license.recognized ? 20 : 12) : 0;
    checks.push({ label: 'License present + recognized SPDX', points: 20, earned: licensePts, detail: license.detail });
    if (!license.present) {
      blockers.push('No LICENSE — required before publishing.');
      findings.push({
        id: 'rel-no-license',
        module: 'release',
        title: 'Missing License',
        summary: 'No LICENSE file or package.json license field was found.',
        severity: 'HIGH',
        confidence: 90,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Without a license, the default is "all rights reserved" — others cannot legally use or contribute to the project. Adding a recognized SPDX license is a prerequisite for any public release.',
        reproducible: true,
        tags: ['release', 'license'],
      });
    }

    const hasWorkflowDir = fs.existsSync(path.join(workspace, '.github', 'workflows'));
    let ciPts = 0;
    let ciDetail: string;
    if (ciTestsConfigured === true) {
      ciPts = 15;
      ciDetail = 'CI configured and runs tests (from CI Health analysis)';
    } else if (ciTestsConfigured === false) {
      ciPts = hasWorkflowDir ? 7 : 0;
      ciDetail = hasWorkflowDir ? 'CI configured but no test step detected (from CI Health analysis)' : 'No CI configuration detected';
    } else {
      ciPts = hasWorkflowDir ? 10 : 0;
      ciDetail = hasWorkflowDir ? 'CI workflow directory present (CI Health not run)' : 'No CI configuration detected';
    }
    checks.push({ label: 'CI configured + tests running', points: 15, earned: ciPts, detail: ciDetail });

    const readmeScore = scoreReadme(workspace);
    const readmePts = Math.round((readmeScore.score / 10) * 15);
    checks.push({ label: 'README quality (>= 7/10)', points: 15, earned: readmePts, detail: `README score ${readmeScore.score}/10` });
    if (!readmeScore.present) {
      blockers.push('No README — add one describing install and usage.');
    }

    const pkg = readPackageJson(workspace);
    let metaPts = 0;
    let metaDetail = 'No package.json found';
    if (pkg) {
      const required = ['name', 'version', 'description', 'license', 'repository'];
      const hasMain = Boolean(pkg.main || pkg.exports || pkg.module || pkg.bin);
      const presentRequired = required.filter((k) => Boolean(pkg[k])).length + (hasMain ? 1 : 0);
      const optional = ['keywords', 'engines', 'bugs', 'homepage'];
      const presentOptional = optional.filter((k) => Boolean(pkg[k])).length;
      metaPts = Math.round((presentRequired / 6) * 11) + Math.round((presentOptional / 4) * 4);
      metaPts = Math.min(15, metaPts);
      metaDetail = `${presentRequired}/6 required + ${presentOptional}/4 optional package.json fields`;
    }
    checks.push({ label: 'Package metadata complete', points: 15, earned: metaPts, detail: metaDetail });

    const hasChangelog = exists(workspace, 'CHANGELOG.md', 'CHANGELOG', 'changelog.md', 'HISTORY.md');
    checks.push({ label: 'CHANGELOG present', points: 10, earned: hasChangelog ? 10 : 0, detail: hasChangelog ? 'CHANGELOG found' : 'No CHANGELOG' });

    let semverPts = 0;
    let semverDetail = 'No version field';
    if (pkg && typeof pkg.version === 'string') {
      const valid = isValidSemver(pkg.version);
      semverPts = valid ? 10 : 3;
      semverDetail = valid ? `Valid semver (${pkg.version})` : `Version "${pkg.version}" is not valid semver`;
    }
    checks.push({ label: 'Valid semver version', points: 10, earned: semverPts, detail: semverDetail });

    const hasExamples = exists(workspace, 'examples', 'example', 'demo', 'samples');
    checks.push({ label: 'Examples present', points: 10, earned: hasExamples ? 10 : 0, detail: hasExamples ? 'Examples directory found' : 'No examples directory' });

    const hasContributing = exists(workspace, 'CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md');
    checks.push({ label: 'CONTRIBUTING present', points: 5, earned: hasContributing ? 5 : 0, detail: hasContributing ? 'CONTRIBUTING found' : 'No CONTRIBUTING' });

    const score = Math.max(0, Math.min(100, checks.reduce((sum, c) => sum + c.earned, 0)));

    context.logger.info(`[M17:release] Release readiness score ${score}/100 (${blockers.length} blockers)`);

    const report = this.buildReport(score, checks, blockers, readmeScore, ciDetail);
    const checklist = this.buildChecklist(checks, context.repoMeta?.name || path.basename(workspace));

    return { score, readmeScore, ciTestsConfigured: ciTestsConfigured === true, checks, blockers, findings, report, checklist };
  }

  private buildReport(score: number, checks: ReleaseCheck[], blockers: string[], readme: ReadmeScore, ciDetail: string): string {
    let md = `# Release Readiness Report\n\n`;
    md += `Release Readiness Score: ${score}/100\n`;
    md += `README score: ${readme.score}/10\n`;
    md += `CI status: ${ciDetail}\n\n`;

    md += `## Score Breakdown\n\n`;
    md += `| Check | Earned | Possible | Detail |\n`;
    md += `|---|---|---|---|\n`;
    for (const c of checks) {
      md += `| ${c.label} | ${c.earned} | ${c.points} | ${c.detail} |\n`;
    }
    md += `\n`;

    md += `## Blockers\n\n`;
    if (blockers.length === 0) {
      md += `*No hard release blockers detected.*\n\n`;
    } else {
      for (const b of blockers) md += `- ${b}\n`;
      md += `\n`;
    }

    md += `## Improvements\n\n`;
    const improvements = checks.filter((c) => c.earned < c.points).sort((a, b) => (b.points - b.earned) - (a.points - a.earned));
    if (improvements.length === 0) {
      md += `*Everything checks out — this project is in great shape for release.*\n`;
    } else {
      for (const c of improvements) {
        md += `- **${c.label}** (+${c.points - c.earned} pts available): ${c.detail}\n`;
      }
    }
    return md;
  }

  private buildChecklist(checks: ReleaseCheck[], repoName: string): string {
    let md = `# Release Checklist — ${repoName}\n\n`;
    md += `This checklist is generated from the actual state of the repository.\n\n`;
    for (const c of checks) {
      const done = c.earned >= c.points;
      md += `- [${done ? 'x' : ' '}] ${c.label} — ${c.detail}\n`;
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
