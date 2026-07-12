import * as fs from 'fs';
import * as path from 'path';
import type { ScanResult, Severity } from '@repo-xray/types';
import { ExportFormat, ExportOptions, ExportTarget } from './index';

// Canonical JSON: sorts keys and drops the volatile runtime block so the same
// repo yields a byte-identical scan.json across runs. Full runtime stays in SQLite.
function stableArtifact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableArtifact);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      if (key === 'runtime') continue;
      out[key] = stableArtifact(record[key]);
    }
    return out;
  }
  return value;
}

async function renderPdfWithPuppeteer(htmlContent: string, outputPath: string): Promise<void> {
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
    await browser.close();
  } catch (err: unknown) {
    const error = err as Error;
    const hint = /Could not find Chrome|Failed to launch|Browser was not found/i.test(error.message)
      ? ' Run "npx puppeteer browsers install chrome" to enable PDF output.'
      : '';
    console.warn(`[export:pdf] Skipped PDF export: ${error.message.split('\n')[0]}.${hint}`);
  }
}

export function generateReportMarkdown(result: ScanResult): string {
  const securityScore = result.scores.security;
  const archScore = result.scores.architecture;
  const overallScore = result.scores.overall;
  const badgeColor = overallScore >= 80 ? 'green' : overallScore >= 50 ? 'orange' : 'red';
  const trustScore = result.meta.runtime ? 91 : 100;

  const criticalFindings = result.findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  const maxCriticalPrint = 100;
  const displayedCritical = criticalFindings.slice(0, maxCriticalPrint);

  let report = `# Repo X-Ray Report

**Repo:** ${result.meta.name}
**Scanned:** ${result.meta.runtime?.startedAt || new Date().toISOString()}
**Mode:** ${result.mode}
**Scan Trust:** ${trustScore}%

## Health Overview

| Category | Score |
|---|---|
| Security | ${securityScore}/100 |
| Architecture | ${archScore}/100 |
| Maintainability | ${result.scores.maintainability}/100 |
| Dependency | ${result.scores.dependency}/100 |
| Test Coverage | ${result.scores.testCoverage}/100 |
| Release Readiness | ${result.scores.releaseReadiness}/100 |
| Overall | ${overallScore}/100 |

## Critical Findings

`;

  if (criticalFindings.length === 0) {
    report += `*No critical or high severity issues found. General health is good!*\n\n`;
  } else {
    for (const f of displayedCritical) {
      report += `### [${f.severity}] ${f.title}\n`;
      report += `- **Summary:** ${f.summary}\n`;
      report += `- **Confidence:** ${f.confidence}%\n`;
      if (f.evidence && f.evidence[0]) {
        report += `- **Location:** \`${f.evidence[0].file}\` (Line ${f.evidence[0].line || 'N/A'})\n`;
      }
      report += `- **Why:** ${f.reasoning}\n\n`;
    }
    if (criticalFindings.length > maxCriticalPrint) {
      report += `\n*Note: Displaying first ${maxCriticalPrint} critical/high findings. See SECURITY.md for all ${criticalFindings.length} findings.*\n\n`;
    }
  }

  report += `## Summary by Category

### Security
- Score: ${securityScore}/100
- Findings: ${result.findings.filter(f => f.module === 'security').length} issues detected. See [SECURITY.md](SECURITY.md) for details.

### Architecture
- Score: ${archScore}/100
- Findings: ${result.findings.filter(f => f.module === 'architecture').length} issues detected. See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Badge

[![X-Ray Score](https://img.shields.io/badge/xray--score-${overallScore}%2F100-${badgeColor}?style=flat)](https://github.com/user/repo)
`;

  return report;
}

export function generateSecurityMarkdown(result: ScanResult): string {
  const secFindings = result.findings.filter(f => f.module === 'security');
  const critical = secFindings.filter(f => f.severity === 'CRITICAL');
  const high = secFindings.filter(f => f.severity === 'HIGH');
  const medium = secFindings.filter(f => f.severity === 'MEDIUM');
  const low = secFindings.filter(f => f.severity === 'LOW');
  const info = secFindings.filter(f => f.severity === 'INFO');

  let md = `# Security Report

Risk Level: ${critical.length > 0 ? 'CRITICAL' : high.length > 0 ? 'HIGH' : 'MEDIUM'}
Findings: ${secFindings.length} (${critical.length} CRITICAL, ${high.length} HIGH, ${medium.length} MEDIUM, ${low.length} LOW, ${info.length} INFO)
Scanned: ${result.meta.totalFiles} files

`;

  const severities: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  for (const sev of severities) {
    const list = secFindings.filter(f => f.severity === sev);
    if (list.length === 0) continue;

    md += `## ${sev}\n\n`;
    const maxPrint = 500;
    const displayed = list.slice(0, maxPrint);
    for (const f of displayed) {
      md += `### ${f.title}\n`;
      if (f.evidence && f.evidence[0]) {
        md += `- **File:** ${f.evidence[0].file}\n`;
        md += `- **Line:** ${f.evidence[0].line || 'N/A'}\n`;
      }
      md += `- **Severity:** ${f.severity}\n`;
      md += `- **Confidence:** ${f.confidence}%\n`;
      if (f.evidence && f.evidence[0] && f.evidence[0].snippet) {
        md += `- **Evidence:** \`${f.evidence[0].snippet}\`\n`;
      }
      md += `- **Fix:** ${f.reasoning}\n\n`;
    }
    if (list.length > maxPrint) {
      md += `*Note: Displaying first ${maxPrint} findings. All ${list.length} findings of this severity are recorded in the database and JSON report.*\n\n`;
    }
  }

  if (secFindings.length === 0) {
    md += `*No security vulnerabilities or secret leaks detected.*`;
  }

  return md;
}

export function generateArchitectureMarkdown(result: ScanResult): string {
  const archFindings = result.findings.filter(f => f.module === 'architecture');
  const cycles = archFindings.filter(f => f.title === 'Circular Dependency Detected');
  const godFiles = archFindings.filter(f => f.title === 'God File (Anti-Pattern)');
  const violations = archFindings.filter(f => f.title === 'Layering Violation');
  const dead = archFindings.filter(f => f.title === 'Dead Module Candidate');

  let md = `# Architecture Report

Architecture Score: ${result.scores.architecture}/100
Style: ${result.meta.frameworks.includes('Next.js') ? 'monorepo/workspace' : 'Standard layout'}

## Issues

`;

  if (cycles.length > 0) {
    md += `### Cyclic Dependencies (${cycles.length})\n\n`;
    for (const c of cycles) {
      md += `- **Cycle:** ${c.summary}\n`;
      md += `- **Why:** Circular dependencies coupling modules tightly. Use dependency inversion.\n\n`;
    }
  }

  if (godFiles.length > 0) {
    md += `### God Files (${godFiles.length})\n\n`;
    for (const g of godFiles) {
      md += `- **File:** ${g.summary}\n`;
      md += `- **Why:** Single responsibilities violated. Refactor into smaller components.\n\n`;
    }
  }

  if (violations.length > 0) {
    md += `### Layering Violations (${violations.length})\n\n`;
    for (const v of violations) {
      md += `- **Violation:** ${v.summary}\n`;
      md += `- **Why:** Core layer references infrastructure/API layer.\n\n`;
    }
  }

  if (dead.length > 0) {
    md += `### Dead Modules (${dead.length})\n\n`;
    for (const d of dead) {
      md += `- **Module:** ${d.summary}\n`;
    }
  }

  if (archFindings.length === 0) {
    md += `*No architectural anti-patterns detected. Codebase structure is clean.*`;
  }

  md += `\n## Dependency Graph\nSee [ARCHITECTURE.html](ARCHITECTURE.html) for interactive visualization.\n`;

  return md;
}

export function generateHtmlDashboard(result: ScanResult): string {
  const overall = result.scores.overall;
  const security = result.scores.security;
  const architecture = result.scores.architecture;
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Repo X-Ray Dashboard - ${result.meta.name}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #1e1e2e;
      color: #cdd6f4;
      margin: 0;
      padding: 40px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      border-bottom: 2px solid #313244;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    h1 {
      margin: 0;
      color: #f5c2e7;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-bottom: 30px;
    }
    .meta-card {
      background-color: #181825;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
    }
    .meta-num {
      font-size: 24px;
      font-weight: bold;
      color: #89b4fa;
      margin-bottom: 5px;
    }
    .meta-label {
      font-size: 14px;
      color: #a6adc8;
    }
    .score-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 30px;
      margin-bottom: 40px;
    }
    .score-card {
      background-color: #11111b;
      border: 2px solid #313244;
      border-radius: 12px;
      padding: 30px;
      text-align: center;
      box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    }
    .score-card.overall {
      border-color: #f5c2e7;
    }
    .score-num {
      font-size: 48px;
      font-weight: bold;
      margin: 15px 0;
    }
    .score-num.good { color: #a6e3a1; }
    .score-num.warn { color: #fab387; }
    .score-num.bad { color: #f38ba8; }
    .score-title {
      font-size: 18px;
      font-weight: bold;
      color: #cdd6f4;
    }
    .finding-list {
      margin-top: 30px;
    }
    .finding-card {
      background-color: #181825;
      border-left: 5px solid #313244;
      border-radius: 4px;
      padding: 20px;
      margin-bottom: 15px;
      border-top: 1px solid #313244;
      border-right: 1px solid #313244;
      border-bottom: 1px solid #313244;
    }
    .finding-card.critical { border-left-color: #f38ba8; }
    .finding-card.high { border-left-color: #fab387; }
    .finding-card.medium { border-left-color: #f9e2af; }
    .finding-card.low { border-left-color: #89b4fa; }
    .finding-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .finding-title {
      font-weight: bold;
      font-size: 18px;
      color: #cdd6f4;
    }
    .finding-sev {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      text-transform: uppercase;
    }
    .finding-sev.critical { background-color: #f38ba8; color: #11111b; }
    .finding-sev.high { background-color: #fab387; color: #11111b; }
    .finding-sev.medium { background-color: #f9e2af; color: #11111b; }
    .finding-sev.low { background-color: #89b4fa; color: #11111b; }
    .finding-evidence {
      background-color: #11111b;
      padding: 10px;
      border-radius: 4px;
      font-family: monospace;
      margin: 10px 0;
      color: #f5e0dc;
      overflow-x: auto;
    }
    .finding-why {
      font-size: 14px;
      color: #bac2de;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Repo X-Ray Intelligence Dashboard</h1>
      <p>Project: <strong>${result.meta.name}</strong> | Scanned at ${result.meta.runtime?.startedAt || new Date().toISOString()}</p>
    </header>

    <div class="meta-grid">
      <div class="meta-card">
        <div class="meta-num">${result.meta.totalFiles}</div>
        <div class="meta-label">Total Files</div>
      </div>
      <div class="meta-card">
        <div class="meta-num">${result.meta.totalLines}</div>
        <div class="meta-label">Total Lines</div>
      </div>
      <div class="meta-card">
        <div class="meta-num">${result.findings.length}</div>
        <div class="meta-label">Findings Count</div>
      </div>
      <div class="meta-card">
        <div class="meta-num">${Object.keys(result.meta.languages).join(', ') || 'N/A'}</div>
        <div class="meta-label">Primary Languages</div>
      </div>
    </div>

    <div class="score-grid">
      <div class="score-card">
        <div class="score-title">Security Grade</div>
        <div class="score-num ${security >= 80 ? 'good' : security >= 50 ? 'warn' : 'bad'}">${security}/100</div>
      </div>
      <div class="score-card overall">
        <div class="score-title">Overall Score</div>
        <div class="score-num ${overall >= 80 ? 'good' : overall >= 50 ? 'warn' : 'bad'}">${overall}/100</div>
      </div>
      <div class="score-card">
        <div class="score-title">Architecture Grade</div>
        <div class="score-num ${architecture >= 80 ? 'good' : architecture >= 50 ? 'warn' : 'bad'}">${architecture}/100</div>
      </div>
    </div>

    <h2>Vulnerability & Anti-Pattern Disclosures</h2>
    <div class="finding-list">
      ${
        result.findings.length === 0
          ? '<p>No findings reported. Your repository is clean and healthy!</p>'
          : (() => {
              const maxHtmlPrint = 1000;
              const displayed = result.findings.slice(0, maxHtmlPrint);
              let html = displayed.map(f => `
                <div class="finding-card ${f.severity.toLowerCase()}">
                  <div class="finding-header">
                    <div class="finding-title">${f.title}</div>
                    <div class="finding-sev ${f.severity.toLowerCase()}">${f.severity}</div>
                  </div>
                  <p><strong>Summary:</strong> ${f.summary}</p>
                  ${
                    f.evidence && f.evidence[0] && f.evidence[0].snippet
                      ? `<div class="finding-evidence">${f.evidence[0].file}:${f.evidence[0].line || 'N/A'}<br/>${f.evidence[0].snippet}</div>`
                      : ''
                  }
                  <div class="finding-why"><strong>Analysis Reasoning:</strong> ${f.reasoning}</div>
                </div>
              `).join('');
              if (result.findings.length > maxHtmlPrint) {
                html += `<p style="text-align: center; margin-top: 20px; font-style: italic;">
                  Note: Displaying first ${maxHtmlPrint} findings. All ${result.findings.length} findings are stored in the SQLite database and JSON outputs.
                </p>`;
              }
              return html;
            })()
      }
    </div>
  </div>
</body>
</html>
`;
}

export function generateSarif(result: ScanResult): string {
  const sarifResults = result.findings.map(f => {
    let level = 'note';
    if (f.severity === 'CRITICAL' || f.severity === 'HIGH') level = 'error';
    else if (f.severity === 'MEDIUM') level = 'warning';

    const location = f.evidence && f.evidence[0]
      ? {
          physicalLocation: {
            artifactLocation: {
              uri: f.evidence[0].file,
            },
            region: {
              startLine: f.evidence[0].line || 1,
            },
          },
        }
      : {
          physicalLocation: {
            artifactLocation: {
              uri: 'unknown',
            },
          },
        };

    return {
      ruleId: f.id,
      message: {
        text: f.summary,
      },
      level,
      locations: [location],
    };
  });

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Repo X-Ray',
            version: '0.1.0',
            rules: result.findings.map(f => ({
              id: f.id,
              shortDescription: {
                text: f.title,
              },
              fullDescription: {
                text: f.reasoning,
              },
            })),
          },
        },
        results: sarifResults,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

export class XRayExportTarget implements ExportTarget {
  supportedFormats(): ExportFormat[] {
    return ['json', 'markdown', 'html', 'sarif', 'pdf'];
  }

  async render(result: ScanResult, options: ExportOptions): Promise<void> {
    const outputDir = options.outputPath;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (options.format === 'markdown') {
      const reportMd = generateReportMarkdown(result);
      const securityMd = generateSecurityMarkdown(result);
      const archMd = generateArchitectureMarkdown(result);

      fs.writeFileSync(path.join(outputDir, 'REPORT.md'), reportMd, 'utf-8');
      fs.writeFileSync(path.join(outputDir, 'SECURITY.md'), securityMd, 'utf-8');
      fs.writeFileSync(path.join(outputDir, 'ARCHITECTURE.md'), archMd, 'utf-8');

      if (options.extraReports) {
        for (const [filename, content] of Object.entries(options.extraReports)) {
          const safeRel = path
            .normalize(filename)
            .replace(/^(\.\.[/\\])+/, '')
            .replace(/^[/\\]+/, '');
          const target = path.resolve(outputDir, safeRel);
          if (!target.startsWith(path.resolve(outputDir))) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, 'utf-8');
        }
      }
    } else if (options.format === 'json') {
      fs.writeFileSync(path.join(outputDir, 'scan.json'), JSON.stringify(stableArtifact(result), null, 2), 'utf-8');
    } else if (options.format === 'html') {
      const html = generateHtmlDashboard(result);
      fs.writeFileSync(path.join(outputDir, 'index.html'), html, 'utf-8');
    } else if (options.format === 'sarif') {
      const sarif = generateSarif(result);
      fs.writeFileSync(path.join(outputDir, 'scan.sarif'), sarif, 'utf-8');
    } else if (options.format === 'pdf') {
      const html = generateHtmlDashboard(result);
      const pdfPath = path.join(outputDir, 'scan.pdf');
      await renderPdfWithPuppeteer(html, pdfPath);
    }
  }
}
