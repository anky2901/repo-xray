import * as fs from 'fs';
import * as path from 'path';

export interface ReadmeScore {
  score: number;
  present: boolean;
  breakdown: Record<string, boolean>;
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

// Scores README quality out of 10. Required sections (install, usage, license)
// are worth 2 points each; optional signals 1 point each.
export function scoreReadme(workspace: string): ReadmeScore {
  const file = findReadme(workspace);
  const breakdown: Record<string, boolean> = {
    installation: false,
    usage: false,
    license: false,
    contributing: false,
    examples: false,
    badges: false,
    apiDocs: false,
    screenshots: false,
  };

  if (!file) {
    return { score: 0, present: false, breakdown };
  }

  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { score: 0, present: false, breakdown };
  }
  const lower = content.toLowerCase();

  breakdown.installation = /(^|\n)#{1,6}.*\b(install|installation|getting started|setup)\b/i.test(content) || /\b(npm|pnpm|yarn|pip)\s+(install|add|i)\b/.test(lower);
  breakdown.usage = /(^|\n)#{1,6}.*\b(usage|quick start|example)\b/i.test(content) || /```/.test(content);
  breakdown.license = /\blicense\b/i.test(lower);
  breakdown.contributing = /\bcontribut/i.test(lower);
  breakdown.examples = /\bexamples?\b/i.test(lower) || /```/.test(content);
  breakdown.badges = /!\[[^\]]*\]\((https?:\/\/img\.shields\.io|https?:\/\/[^)]*badge[^)]*)\)/i.test(content);
  breakdown.apiDocs = /(^|\n)#{1,6}.*\b(api|reference|documentation)\b/i.test(content);
  breakdown.screenshots = /!\[[^\]]*\]\([^)]+\.(png|jpg|jpeg|gif|svg|webp)\)/i.test(content) || /\.(gif|mp4|webm)\b/i.test(lower);

  let score = 0;
  if (breakdown.installation) score += 2;
  if (breakdown.usage) score += 2;
  if (breakdown.license) score += 2;
  for (const key of ['contributing', 'examples', 'badges', 'apiDocs', 'screenshots'] as const) {
    if (breakdown[key]) score += 1;
  }
  score = Math.min(10, score);

  return { score, present: true, breakdown };
}
