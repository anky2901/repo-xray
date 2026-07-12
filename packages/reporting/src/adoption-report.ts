import * as fs from 'fs';
import * as path from 'path';
import type { ScanResult } from '@repo-xray/types';

export interface AdoptionFactor {
  factor: string;
  score: string;
  weight: 'High' | 'Medium' | 'Low';
}

export interface AdoptionReport {
  category: string;
  starRange: string;
  confidence: number;
  report: string;
}

function findReadme(workspace: string): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    return null;
  }
  const match = entries.find((e) => /^readme(\.md|\.rst|\.txt)?$/i.test(e));
  return match ? path.join(workspace, match) : null;
}

function readmeQuality(workspace: string): { score: number; hasDemo: boolean } {
  const file = findReadme(workspace);
  if (!file) return { score: 0, hasDemo: false };
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { score: 0, hasDemo: false };
  }
  const lower = content.toLowerCase();
  let score = 0;
  if (/\b(install|installation|getting started)\b/.test(lower)) score += 2;
  if (/```/.test(content)) score += 2;
  if (/\blicense\b/.test(lower)) score += 2;
  if (/!\[[^\]]*\]\([^)]*badge[^)]*\)|img\.shields\.io/.test(content)) score += 1;
  if (/\bcontribut/.test(lower)) score += 1;
  const hasDemo = /!\[[^\]]*\]\([^)]+\.(png|jpg|jpeg|gif|svg|webp)\)/i.test(content) || /\.(gif|mp4|webm)\b/i.test(lower);
  if (hasDemo) score += 2;
  return { score: Math.min(10, score), hasDemo };
}

function detectCategory(result: ScanResult): string {
  const fw = result.meta.frameworks;
  if (fw.includes('Next.js') || fw.includes('React') || fw.includes('Vue') || fw.includes('Svelte') || fw.includes('Angular')) {
    return 'Frontend / web application';
  }
  if (fw.includes('Express') || fw.includes('FastAPI') || fw.includes('Django') || fw.includes('Flask') || fw.includes('Spring') || fw.includes('Rails')) {
    return 'Backend / API framework';
  }
  if (result.meta.entrypoints?.some((e) => e.includes('cli') || e.includes('cmd') || e.includes('bin'))) {
    return 'Developer tooling / CLI';
  }
  return 'Library / general purpose';
}

export function generateAdoptionReport(workspace: string, result: ScanResult): AdoptionReport {
  const readme = readmeQuality(workspace);
  const hasContributing = ['CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md'].some((f) =>
    fs.existsSync(path.join(workspace, f))
  );
  const hasExamples = ['examples', 'example', 'demo', 'samples'].some((d) => fs.existsSync(path.join(workspace, d)));
  const category = detectCategory(result);

  const onboarding = readme.score >= 7 && hasExamples ? 'Low' : readme.score >= 4 ? 'Medium' : 'High';

  const factors: AdoptionFactor[] = [
    { factor: 'README quality', score: `${readme.score}/10`, weight: 'High' },
    { factor: 'Onboarding friction', score: onboarding, weight: 'High' },
    { factor: 'Demoability', score: readme.hasDemo ? 'Has demo media' : 'No gif/video', weight: 'Medium' },
    { factor: 'Examples present', score: hasExamples ? 'Yes' : 'No', weight: 'Medium' },
    { factor: 'Contributor friendliness', score: hasContributing ? 'CONTRIBUTING present' : 'No CONTRIBUTING', weight: 'Medium' },
    { factor: 'Release readiness', score: `${result.scores.releaseReadiness}/100`, weight: 'High' },
  ];

  // Weighted 0..1 signal feeding a bounded star estimate. Confidence stays well
  // below 100 because adoption depends on factors no static scan can observe.
  let signal = 0;
  signal += (readme.score / 10) * 0.3;
  signal += (onboarding === 'Low' ? 1 : onboarding === 'Medium' ? 0.5 : 0.1) * 0.2;
  signal += (readme.hasDemo ? 1 : 0) * 0.15;
  signal += (hasExamples ? 1 : 0) * 0.1;
  signal += (hasContributing ? 1 : 0) * 0.1;
  signal += (result.scores.releaseReadiness / 100) * 0.15;

  const ranges = [
    { max: 0.25, label: '0–100' },
    { max: 0.45, label: '100–300' },
    { max: 0.65, label: '300–800' },
    { max: 0.82, label: '800–2k' },
    { max: 1.01, label: '2k+' },
  ];
  const starRange = ranges.find((r) => signal < r.max)?.label ?? '300–800';
  const confidence = Math.min(70, 35 + Math.round(signal * 30));

  const blockers: string[] = [];
  if (!readme.hasDemo) blockers.push('No demo gif or video in the README.');
  if (onboarding !== 'Low') blockers.push('Onboarding takes more than a glance; reduce setup to one step.');
  if (!hasExamples) blockers.push('No examples directory.');
  if (readme.score < 7) blockers.push('README is below 7/10; expand install and usage sections.');

  const accelerators = [
    'Add a one-line install and a copy-paste quick start to the top of the README.',
    'Record a short demo gif showing the core workflow.',
    'Add an examples/ directory with runnable snippets.',
  ];

  let md = `# Adoption Potential\n\n`;
  md += `Category: ${category}\n`;
  md += `Estimated stars (6 months): ${starRange}\n`;
  md += `Confidence: ${confidence}% (estimate; adoption depends on factors a static scan cannot measure)\n\n`;
  md += `## Score Breakdown\n\n`;
  md += `| Factor | Score | Weight |\n|---|---|---|\n`;
  for (const f of factors) {
    md += `| ${f.factor} | ${f.score} | ${f.weight} |\n`;
  }
  md += `\n## Top Adoption Blockers\n\n`;
  md += (blockers.length ? blockers : ['No major blockers detected.']).map((b) => `- ${b}`).join('\n');
  md += `\n\n## Top Adoption Accelerators\n\n`;
  md += accelerators.map((a) => `- ${a}`).join('\n');
  md += `\n`;

  return { category, starRange, confidence, report: md };
}
