import type { ScanResult, Finding } from '@repo-xray/types';

export interface VulnReport {
  count: number;
  report: string;
}

interface FixTemplate {
  why: string;
  exploitability: { remote: string; authenticated: string; complexity: string };
  impact: { exfiltration: string; rce: string; privEsc: string };
  minimalFix: string;
  bestPractice: string;
  aiPrompt: string;
  testFix: string;
}

function templateFor(f: Finding): FixTemplate {
  const file = f.evidence[0]?.file || 'the affected file';
  const line = f.evidence[0]?.line ? `line ${f.evidence[0].line}` : 'the affected line';

  if (f.tags.includes('sql-injection')) {
    return {
      why: 'User input is concatenated directly into a SQL string, so an attacker can alter the query structure and read or modify data outside their scope.',
      exploitability: { remote: 'yes', authenticated: 'no', complexity: 'LOW' },
      impact: { exfiltration: 'yes', rce: 'no', privEsc: 'possible' },
      minimalFix: `- db.query(\`SELECT * FROM users WHERE id = \${id}\`)\n+ db.query('SELECT * FROM users WHERE id = ?', [id])`,
      bestPractice: 'Use parameterized queries through an ORM (Prisma/TypeORM/Drizzle). Validate input at the route layer and never interpolate untrusted values into SQL.',
      aiPrompt: `Fix the SQL injection in ${file} at ${line}.\nRules:\n- preserve the existing API contract\n- parameterize every query in this file\n- validate input at the route level\n- update related tests\n- explain every change made`,
      testFix: `test('rejects SQL injection attempt', async () => {\n  const res = await request(app).get('/users/1 OR 1=1')\n  expect(res.status).toBe(400)\n})`,
    };
  }

  if (f.tags.includes('xss')) {
    return {
      why: 'Dynamic content is written into the DOM via innerHTML, allowing injected markup and scripts to execute in the victim browser.',
      exploitability: { remote: 'yes', authenticated: 'no', complexity: 'LOW' },
      impact: { exfiltration: 'yes', rce: 'no', privEsc: 'possible' },
      minimalFix: `- el.innerHTML = userInput\n+ el.textContent = userInput`,
      bestPractice: 'Render untrusted content as text, or sanitize with a vetted library (DOMPurify) before assigning to innerHTML. Prefer framework-escaped templating.',
      aiPrompt: `Fix the XSS sink in ${file} at ${line}.\nRules:\n- render untrusted data as text or sanitize before insertion\n- keep the existing behavior for trusted content\n- update related tests\n- explain every change made`,
      testFix: `test('escapes script payloads', () => {\n  render('<img src=x onerror=alert(1)>')\n  expect(container.querySelector('img')).toBeNull()\n})`,
    };
  }

  if (f.tags.includes('code-injection')) {
    return {
      why: 'eval() executes a string as code in the current scope; if any part of that string is attacker-controlled it becomes arbitrary code execution.',
      exploitability: { remote: 'depends on input source', authenticated: 'depends', complexity: 'MEDIUM' },
      impact: { exfiltration: 'yes', rce: 'yes', privEsc: 'possible' },
      minimalFix: `- const result = eval(expr)\n+ const result = JSON.parse(expr)`,
      bestPractice: 'Replace eval with an explicit parser or a safe lookup table. If dynamic evaluation is unavoidable, run it in a sandbox with no ambient authority.',
      aiPrompt: `Remove the eval() in ${file} at ${line}.\nRules:\n- replace with a safe parser or explicit dispatch\n- do not change the public behavior for valid input\n- update related tests\n- explain every change made`,
      testFix: `test('does not execute injected code', () => {\n  expect(() => evaluate('process.exit(1)')).toThrow()\n})`,
    };
  }

  if (f.tags.includes('secret') || f.tags.includes('credential') || f.tags.includes('leak')) {
    return {
      why: 'A live credential is committed to the repository, so anyone with read access (or anyone who clones the history) can use it directly.',
      exploitability: { remote: 'yes', authenticated: 'no', complexity: 'LOW' },
      impact: { exfiltration: 'yes', rce: 'no', privEsc: 'possible' },
      minimalFix: `- const apiKey = 'sk-...'\n+ const apiKey = process.env.API_KEY`,
      bestPractice: 'Move the secret to an environment variable or secret manager, rotate the exposed credential immediately, and add the file to .gitignore. Rotation matters because the value is already in git history.',
      aiPrompt: `Remove the hardcoded secret in ${file} at ${line}.\nRules:\n- read the value from the environment instead\n- add the source file to .gitignore if it is a config file\n- do not print the secret anywhere\n- explain every change made`,
      testFix: `test('reads the credential from the environment', () => {\n  process.env.API_KEY = 'test'\n  expect(getApiKey()).toBe('test')\n})`,
    };
  }

  if (f.tags.includes('cve') || f.tags.includes('supply-chain')) {
    return {
      why: 'A dependency version with a published advisory is in use, so the project inherits that vulnerability until the package is upgraded.',
      exploitability: { remote: 'depends on advisory', authenticated: 'depends', complexity: 'depends' },
      impact: { exfiltration: 'depends', rce: 'depends', privEsc: 'depends' },
      minimalFix: 'Upgrade the affected package to the first patched version listed in the advisory.',
      bestPractice: 'Pin the patched version, run the test suite, and enable automated dependency updates so future advisories are picked up quickly.',
      aiPrompt: `Upgrade the vulnerable dependency referenced in ${file}.\nRules:\n- move to the patched version from the advisory\n- run the test suite after upgrading\n- note any breaking changes you had to adapt to\n- explain every change made`,
      testFix: 'Run the existing suite after the upgrade; add a regression test if the advisory describes a reproducible behavior.',
    };
  }

  return {
    why: f.reasoning,
    exploitability: { remote: 'unknown', authenticated: 'unknown', complexity: 'unknown' },
    impact: { exfiltration: 'unknown', rce: 'unknown', privEsc: 'unknown' },
    minimalFix: 'Address the condition described in the finding reasoning.',
    bestPractice: 'Apply the standard remediation for this class of issue and add a regression test.',
    aiPrompt: `Fix the issue "${f.title}" in ${file} at ${line}.\nRules:\n- preserve existing behavior for valid input\n- update related tests\n- explain every change made`,
    testFix: 'Add a test that fails before the fix and passes after it.',
  };
}

export function generateVulnReport(result: ScanResult): VulnReport {
  const targets = result.findings
    .filter((f) => f.module === 'security' && (f.severity === 'CRITICAL' || f.severity === 'HIGH'))
    .sort((a, b) => a.id.localeCompare(b.id));

  let md = `# Vulnerability Fix Report\n\n`;
  md += `Repo: ${result.meta.name}\n`;
  md += `Actionable findings (CRITICAL + HIGH): ${targets.length}\n\n`;

  if (targets.length === 0) {
    md += `*No critical or high severity security findings to fix.*\n`;
    return { count: 0, report: md };
  }

  for (const f of targets) {
    const t = templateFor(f);
    const ev = f.evidence[0];
    md += `## ${f.title}\n\n`;
    md += `Severity: ${f.severity} | Confidence: ${f.confidence}%\n\n`;
    md += `Evidence:\n`;
    md += `  File: ${ev?.file ?? 'n/a'}${ev?.line ? ` | Line: ${ev.line}` : ''}\n`;
    if (ev?.snippet) md += `  Snippet: ${ev.snippet}\n`;
    md += `\nWhy vulnerable:\n  ${t.why}\n\n`;
    md += `Exploitability:\n  Remote: ${t.exploitability.remote} | Authenticated: ${t.exploitability.authenticated} | Complexity: ${t.exploitability.complexity}\n\n`;
    md += `Impact:\n  Data exfiltration: ${t.impact.exfiltration} | RCE: ${t.impact.rce} | Privilege escalation: ${t.impact.privEsc}\n\n`;
    md += `--- Minimal Fix ---\n\`\`\`diff\n${t.minimalFix}\n\`\`\`\n\n`;
    md += `--- Best Practice Fix ---\n${t.bestPractice}\n\n`;
    md += `--- AI Fix Prompt (copy-paste ready) ---\n\`\`\`\n${t.aiPrompt}\n\`\`\`\n\n`;
    md += `--- Test Fix ---\n\`\`\`\n${t.testFix}\n\`\`\`\n\n`;
  }

  return { count: targets.length, report: md };
}
