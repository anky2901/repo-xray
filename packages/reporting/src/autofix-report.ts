import type { ScanResult, Finding, Severity } from '@repo-xray/types';

export interface AutofixReport {
  actionable: number;
  report: string;
}

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

interface FixHint {
  match: (f: Finding) => boolean;
  suggest: (f: Finding) => string;
}

const HINTS: FixHint[] = [
  {
    match: (f) => f.tags.includes('secret') || f.tags.includes('credential') || f.tags.includes('leak'),
    suggest: () => 'Move the value to an environment variable or secret manager, rotate the exposed credential, and add the file to .gitignore.',
  },
  {
    match: (f) => f.tags.includes('sql-injection'),
    suggest: () => 'Replace string concatenation with parameterized queries; validate input at the route layer.',
  },
  {
    match: (f) => f.tags.includes('xss'),
    suggest: () => 'Render untrusted data as text or sanitize with DOMPurify before assigning to innerHTML.',
  },
  {
    match: (f) => f.tags.includes('code-injection'),
    suggest: () => 'Remove eval(); use an explicit parser or dispatch table instead.',
  },
  {
    match: (f) => f.tags.includes('cve') || f.tags.includes('supply-chain'),
    suggest: () => 'Upgrade the dependency to the first patched version from the advisory and re-run tests.',
  },
  {
    match: (f) => f.tags.includes('duplicate'),
    suggest: () => 'Deduplicate the lockfile or align version ranges so a single version resolves.',
  },
  {
    match: (f) => f.tags.includes('bundle-size'),
    suggest: (f) => `Swap ${f.title.replace('Heavyweight Dependency: ', '')} for the lighter alternative noted in DEPENDENCY.md.`,
  },
  {
    match: (f) => f.module === 'ci-health' && f.tags.includes('supply-chain'),
    suggest: () => 'Pin the GitHub Action to a full commit SHA instead of a mutable tag.',
  },
  {
    match: (f) => f.tags.includes('whitespace') || f.tags.includes('quotes') || f.tags.includes('indentation') || f.tags.includes('line-length'),
    suggest: () => 'Run a formatter (Prettier) and add an editorconfig to normalize style automatically.',
  },
  {
    match: (f) => f.tags.includes('flaky'),
    suggest: () => 'Introduce fake timers or mock the network call so the test is deterministic.',
  },
];

function suggestionFor(f: Finding): string {
  for (const h of HINTS) {
    if (h.match(f)) return h.suggest(f);
  }
  return f.reasoning.split('. ')[0] + '.';
}

export function generateAutofixReport(result: ScanResult): AutofixReport {
  const actionable = result.findings
    .filter((f) => f.severity !== 'INFO' && f.reproducible)
    .sort((a, b) => {
      const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      return s !== 0 ? s : a.id.localeCompare(b.id);
    });

  let md = `# Autofix Suggestions\n\n`;
  md += `Repo: ${result.meta.name}\n`;
  md += `Actionable findings: ${actionable.length}\n\n`;
  md += `> Each entry pairs a finding with a concrete first step. Review every change before applying; these are suggestions, not automatic edits.\n\n`;

  if (actionable.length === 0) {
    md += `*No actionable findings to fix.*\n`;
    return { actionable: 0, report: md };
  }

  for (const sev of SEVERITY_ORDER) {
    const group = actionable.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    md += `## ${sev} (${group.length})\n\n`;
    for (const f of group) {
      const loc = f.evidence[0]?.file ? ` — ${f.evidence[0].file}${f.evidence[0].line ? `:${f.evidence[0].line}` : ''}` : '';
      md += `- **${f.title}**${loc}\n`;
      md += `  - Fix: ${suggestionFor(f)}\n`;
    }
    md += `\n`;
  }

  return { actionable: actionable.length, report: md };
}
