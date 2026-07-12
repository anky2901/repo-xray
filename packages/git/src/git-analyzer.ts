import { execSync } from 'child_process';
import type { ScanContext, Analyzer, Finding } from '@repo-xray/types';

export interface GitStats {
  isRepo: boolean;
  totalCommits: number;
  contributors: number;
  commitsPerWeek: number;
  firstCommit?: string;
  lastCommit?: string;
  topContributorShare: number;
  hotspots: { file: string; changes: number }[];
}

export interface GitAnalysis {
  stats: GitStats;
  findings: Finding[];
  report: string;
}

function git(workspace: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function collectStats(workspace: string): GitStats {
  const empty: GitStats = {
    isRepo: false,
    totalCommits: 0,
    contributors: 0,
    commitsPerWeek: 0,
    topContributorShare: 0,
    hotspots: [],
  };

  if (git(workspace, 'rev-parse --is-inside-work-tree') !== 'true') {
    return empty;
  }

  const countRaw = git(workspace, 'rev-list --count HEAD');
  const totalCommits = countRaw ? parseInt(countRaw, 10) || 0 : 0;
  if (totalCommits === 0) {
    return { ...empty, isRepo: true };
  }

  const shortlog = git(workspace, 'shortlog -sn --all --no-merges') || '';
  const authorLines = shortlog.split(/\r?\n/).filter((l) => l.trim());
  const authorCounts = authorLines
    .map((l) => parseInt(l.trim().split(/\s+/)[0], 10) || 0)
    .filter((n) => n > 0);
  const contributors = authorCounts.length;
  const totalAuthored = authorCounts.reduce((a, b) => a + b, 0) || 1;
  const topContributorShare = contributors ? authorCounts[0] / totalAuthored : 0;

  const firstCommit = git(workspace, 'log --reverse --format=%cI --max-count=1') || undefined;
  const lastCommit = git(workspace, 'log -1 --format=%cI') || undefined;

  let commitsPerWeek = 0;
  if (firstCommit && lastCommit) {
    const spanMs = Date.parse(lastCommit) - Date.parse(firstCommit);
    const weeks = Math.max(1, spanMs / (1000 * 60 * 60 * 24 * 7));
    commitsPerWeek = Math.round((totalCommits / weeks) * 10) / 10;
  }

  const hotspots = computeHotspots(workspace);

  return {
    isRepo: true,
    totalCommits,
    contributors,
    commitsPerWeek,
    firstCommit,
    lastCommit,
    topContributorShare,
    hotspots,
  };
}

function computeHotspots(workspace: string): { file: string; changes: number }[] {
  const log = git(workspace, 'log --pretty=format: --name-only --no-merges -n 2000');
  if (!log) return [];
  const counts = new Map<string, number>();
  for (const line of log.split(/\r?\n/)) {
    const file = line.trim();
    if (!file) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, changes]) => ({ file, changes }))
    .sort((a, b) => b.changes - a.changes || a.file.localeCompare(b.file))
    .slice(0, 10);
}

export class XRayGitAnalyzer implements Analyzer {
  readonly id = 'git';
  readonly name = 'Git Intelligence';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  analyze(context: ScanContext): GitAnalysis {
    const stats = collectStats(context.workspacePath);
    const findings: Finding[] = [];

    context.logger.info(`[M7:git] ${stats.isRepo ? `${stats.totalCommits} commits, ${stats.contributors} contributors` : 'not a git repository'}`);

    if (stats.isRepo && stats.totalCommits > 0) {
      if (stats.contributors === 1) {
        findings.push({
          id: 'git-bus-factor',
          module: 'git',
          title: 'Single-Contributor Bus Factor',
          summary: 'All commits come from a single author.',
          severity: 'LOW',
          confidence: 70,
          evidence: [{ file: '.', line: 1, snippet: `${stats.totalCommits} commits, 1 author` }],
          reasoning: 'A project with one contributor has a bus factor of one: if that person becomes unavailable, maintenance stalls. Documenting setup and inviting reviewers reduces the risk.',
          reproducible: true,
          tags: ['git', 'bus-factor'],
        });
      } else if (stats.topContributorShare > 0.9 && stats.contributors > 1) {
        findings.push({
          id: 'git-ownership-concentration',
          module: 'git',
          title: 'Concentrated Ownership',
          summary: `One author made ${(stats.topContributorShare * 100).toFixed(0)}% of commits.`,
          severity: 'LOW',
          confidence: 60,
          evidence: [{ file: '.', line: 1, snippet: `top author share ${(stats.topContributorShare * 100).toFixed(0)}%` }],
          reasoning: 'Highly concentrated commit ownership signals knowledge silos. Spreading reviews and pairing on unfamiliar areas keeps the codebase maintainable as the team changes.',
          reproducible: true,
          tags: ['git', 'ownership'],
        });
      }

      if (stats.lastCommit) {
        const daysSinceLast = (Date.now() - Date.parse(stats.lastCommit)) / (1000 * 60 * 60 * 24);
        if (daysSinceLast > 180) {
          findings.push({
            id: 'git-stale',
            module: 'git',
            title: 'Stale Repository',
            summary: `The most recent commit is ${Math.floor(daysSinceLast)} days old.`,
            severity: 'LOW',
            confidence: 65,
            evidence: [{ file: '.', line: 1, snippet: `last commit ${stats.lastCommit.slice(0, 10)}` }],
            reasoning: 'No commits in over six months suggests the project may be unmaintained. Confirm whether it is still supported before depending on it.',
            reproducible: true,
            tags: ['git', 'activity'],
          });
        }
      }
    }

    const report = this.buildReport(stats, findings);
    return { stats, findings, report };
  }

  private buildReport(stats: GitStats, findings: Finding[]): string {
    let md = `# Git Intelligence Report\n\n`;
    if (!stats.isRepo) {
      md += `*No git history found (the source is not a git repository).*\n`;
      return md;
    }

    md += `Total commits: ${stats.totalCommits}\n`;
    md += `Contributors: ${stats.contributors}\n`;
    md += `Commit velocity: ${stats.commitsPerWeek}/week\n`;
    if (stats.firstCommit) md += `First commit: ${stats.firstCommit.slice(0, 10)}\n`;
    if (stats.lastCommit) md += `Last commit: ${stats.lastCommit.slice(0, 10)}\n`;
    md += `Top contributor share: ${(stats.topContributorShare * 100).toFixed(0)}%\n\n`;

    if (stats.hotspots.length) {
      md += `## Churn Hotspots (most frequently changed files)\n\n`;
      md += `| File | Changes |\n|---|---|\n`;
      for (const h of stats.hotspots) {
        md += `| ${h.file} | ${h.changes} |\n`;
      }
      md += `\n`;
    }

    md += `## Findings\n\n`;
    if (findings.length === 0) {
      md += `*No git health concerns detected.*\n`;
    } else {
      for (const f of [...findings].sort((a, b) => a.id.localeCompare(b.id))) {
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
