import * as fs from 'fs';
import * as path from 'path';
import type { ScanContext, Analyzer, Finding, ScanResult } from '@repo-xray/types';

export interface BusinessProfile {
  purpose: string;
  domain: string;
  primaryUsers: string;
  distribution: string;
  keywords: string[];
  entrypoints: string[];
}

export interface BusinessAnalysis {
  profile: BusinessProfile;
  findings: Finding[];
  report: string;
}

interface DomainRule {
  domain: string;
  keywords: RegExp;
}

const DOMAIN_RULES: DomainRule[] = [
  { domain: 'Developer tooling', keywords: /\b(cli|lint|scanner|compiler|bundler|formatter|codegen|sdk|devtool)\b/i },
  { domain: 'Web frontend', keywords: /\b(react|vue|svelte|next|nuxt|component|ui|frontend|dashboard)\b/i },
  { domain: 'Backend service / API', keywords: /\b(api|server|rest|graphql|microservice|endpoint|backend)\b/i },
  { domain: 'Data / ML', keywords: /\b(data|ml|machine learning|model|dataset|pipeline|analytics|etl)\b/i },
  { domain: 'DevOps / Infrastructure', keywords: /\b(docker|kubernetes|terraform|deploy|infra|ci\/cd|pipeline)\b/i },
  { domain: 'Security', keywords: /\b(security|auth|encryption|vulnerabilit|secret|pentest)\b/i },
  { domain: 'E-commerce / Payments', keywords: /\b(payment|checkout|cart|stripe|billing|invoice|commerce)\b/i },
];

function readPackageJson(workspace: string): Record<string, unknown> | null {
  const p = path.join(workspace, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readReadme(workspace: string): string {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    return '';
  }
  const file = entries.find((e) => /^readme(\.md|\.rst|\.txt)?$/i.test(e));
  if (!file) return '';
  try {
    return fs.readFileSync(path.join(workspace, file), 'utf-8');
  } catch {
    return '';
  }
}

export class XRayBusinessAnalyzer implements Analyzer {
  readonly id = 'business';
  readonly name = 'Business Intelligence';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext, result?: ScanResult): BusinessAnalysis {
    const workspace = context.workspacePath;
    const pkg = readPackageJson(workspace);
    const readme = readReadme(workspace);
    const meta = result?.meta ?? context.repoMeta;

    const description = pkg && typeof pkg.description === 'string' ? pkg.description : '';
    const keywords = pkg && Array.isArray(pkg.keywords) ? (pkg.keywords as string[]).map(String) : [];
    const corpus = `${description} ${keywords.join(' ')} ${readme.slice(0, 4000)} ${(meta.frameworks || []).join(' ')} ${(meta.entrypoints || []).join(' ')}`;

    let domain = 'General purpose';
    for (const rule of DOMAIN_RULES) {
      if (rule.keywords.test(corpus)) {
        domain = rule.domain;
        break;
      }
    }

    const distribution = this.inferDistribution(workspace, pkg, meta);
    const primaryUsers = /Developer tooling|Backend|API|Security/i.test(domain) ? 'Developers / engineers' : 'End users';
    const purpose = this.inferPurpose(description, readme, meta.name);

    const profile: BusinessProfile = {
      purpose,
      domain,
      primaryUsers,
      distribution,
      keywords,
      entrypoints: meta.entrypoints || [],
    };

    const findings: Finding[] = [];
    if (!description && !readme) {
      findings.push({
        id: 'business-no-description',
        module: 'business',
        title: 'Undocumented Purpose',
        summary: 'No package description or README was found to convey the project purpose.',
        severity: 'LOW',
        confidence: 60,
        evidence: [{ file: '.', line: 1 }],
        reasoning: 'Without a description or README, newcomers and evaluators cannot tell what the project does or why it exists. A one-paragraph summary at the top of the README is the highest-leverage documentation a project can have.',
        reproducible: true,
        tags: ['business', 'documentation'],
      });
    }

    context.logger.info(`[M6:business] Domain: ${domain}`);
    const report = this.buildReport(profile, findings);
    return { profile, findings, report };
  }

  private inferDistribution(workspace: string, pkg: Record<string, unknown> | null, meta: ScanContext['repoMeta']): string {
    if (pkg && (pkg.bin || (typeof pkg.name === 'string' && (meta.entrypoints || []).some((e) => /cli|bin|cmd/.test(e))))) {
      return 'CLI / npm package';
    }
    if (pkg && (pkg.private === true)) return 'Private application';
    if (fs.existsSync(path.join(workspace, 'Dockerfile'))) return 'Containerized service';
    if (pkg && pkg.name) return 'Published library / package';
    return 'Application';
  }

  private inferPurpose(description: string, readme: string, name: string): string {
    if (description) return description;
    const lines = readme.split(/\r?\n/).map((l) => l.trim());
    for (const line of lines) {
      if (line && !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('[!') && line.length > 20) {
        return line.slice(0, 200);
      }
    }
    return `Purpose not documented for "${name}".`;
  }

  private buildReport(profile: BusinessProfile, findings: Finding[]): string {
    let md = `# Business Intelligence Report\n\n`;
    md += `Inferred purpose: ${profile.purpose}\n`;
    md += `Domain: ${profile.domain}\n`;
    md += `Primary users: ${profile.primaryUsers}\n`;
    md += `Distribution: ${profile.distribution}\n`;
    if (profile.keywords.length) md += `Keywords: ${profile.keywords.join(', ')}\n`;
    if (profile.entrypoints.length) md += `Entrypoints: ${profile.entrypoints.slice(0, 5).join(', ')}\n`;
    md += `\n> Inference is heuristic, drawn from metadata, README, and structure. Treat it as a starting point, not ground truth.\n\n`;
    md += `## Findings\n\n`;
    if (findings.length === 0) {
      md += `*Project purpose is documented and discoverable.*\n`;
    } else {
      for (const f of findings) {
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
