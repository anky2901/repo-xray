import type { ScanResult, Finding, Severity } from '@repo-xray/types';

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scoreClass(score: number): string {
  return score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad';
}

function scoreCards(result: ScanResult): string {
  const cards: [string, number][] = [
    ['Overall', result.scores.overall],
    ['Security', result.scores.security],
    ['Architecture', result.scores.architecture],
    ['Maintainability', result.scores.maintainability],
    ['Dependency', result.scores.dependency],
    ['Test Coverage', result.scores.testCoverage],
    ['Release', result.scores.releaseReadiness],
  ];
  return cards
    .map(
      ([label, score]) => `
      <div class="score-card">
        <div class="score-title">${escapeHtml(label)}</div>
        <div class="score-num ${scoreClass(score)}">${score}</div>
      </div>`
    )
    .join('');
}

function severityCounts(findings: Finding[]): string {
  return SEVERITY_ORDER.map((sev) => {
    const n = findings.filter((f) => f.severity === sev).length;
    return `<span class="pill ${sev.toLowerCase()}">${sev}: ${n}</span>`;
  }).join(' ');
}

function findingRows(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return s !== 0 ? s : a.module.localeCompare(b.module) || a.id.localeCompare(b.id);
  });
  const shown = sorted.slice(0, 500);
  const rows = shown
    .map((f) => {
      const loc = f.evidence[0]?.file ? `${escapeHtml(f.evidence[0].file)}${f.evidence[0].line ? `:${f.evidence[0].line}` : ''}` : '';
      return `
      <tr class="row ${f.severity.toLowerCase()}" data-severity="${f.severity}" data-module="${escapeHtml(f.module)}">
        <td><span class="pill ${f.severity.toLowerCase()}">${f.severity}</span></td>
        <td>${escapeHtml(f.module)}</td>
        <td>${escapeHtml(f.title)}</td>
        <td>${f.confidence}%</td>
        <td class="loc">${loc}</td>
      </tr>`;
    })
    .join('');
  const note = sorted.length > shown.length ? `<p class="note">Showing first ${shown.length} of ${sorted.length} findings.</p>` : '';
  return rows + '</tbody></table>' + note;
}

export function renderDashboard(result: ScanResult): string {
  const langs = Object.entries(result.meta.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([l, p]) => `${escapeHtml(l)} ${p}%`)
    .join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Repo X-Ray — ${escapeHtml(result.meta.name)}</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1e1e2e; color: #cdd6f4; margin: 0; padding: 32px; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { color: #f5c2e7; margin: 0 0 4px; }
    .meta { color: #a6adc8; margin-bottom: 24px; }
    .score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .score-card { background: #181825; border: 1px solid #313244; border-radius: 10px; padding: 18px; text-align: center; }
    .score-title { font-size: 13px; color: #a6adc8; margin-bottom: 8px; }
    .score-num { font-size: 34px; font-weight: 700; }
    .score-num.good { color: #a6e3a1; } .score-num.warn { color: #fab387; } .score-num.bad { color: #f38ba8; }
    .controls { margin-bottom: 12px; }
    .controls input, .controls select { background: #181825; color: #cdd6f4; border: 1px solid #313244; border-radius: 6px; padding: 6px 10px; margin-right: 8px; }
    table { width: 100%; border-collapse: collapse; background: #181825; border-radius: 10px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #313244; font-size: 14px; }
    th { color: #89b4fa; }
    .loc { font-family: monospace; color: #f5e0dc; font-size: 12px; }
    .pill { padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .pill.critical { background: #f38ba8; color: #11111b; } .pill.high { background: #fab387; color: #11111b; }
    .pill.medium { background: #f9e2af; color: #11111b; } .pill.low { background: #89b4fa; color: #11111b; } .pill.info { background: #585b70; color: #cdd6f4; }
    .note { color: #a6adc8; font-size: 13px; }
    .summary { margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Repo X-Ray</h1>
      <div class="meta">${escapeHtml(result.meta.name)} &middot; mode: ${escapeHtml(result.mode)} &middot; ${result.meta.totalFiles} files &middot; ${escapeHtml(langs || 'n/a')}</div>
    </header>

    <section class="score-grid">${scoreCards(result)}</section>

    <section class="summary">
      <strong>${result.findings.length}</strong> findings &nbsp; ${severityCounts(result.findings)}
    </section>

    <div class="controls">
      <input id="filterText" type="text" placeholder="Filter by title/module...">
      <select id="filterSeverity">
        <option value="">All severities</option>
        ${SEVERITY_ORDER.map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>

    <table>
      <thead><tr><th>Severity</th><th>Module</th><th>Title</th><th>Confidence</th><th>Location</th></tr></thead>
      <tbody id="findings">
        ${findingRows(result.findings)}

  <script>
    const text = document.getElementById('filterText');
    const sev = document.getElementById('filterSeverity');
    function apply() {
      const t = text.value.toLowerCase();
      const s = sev.value;
      document.querySelectorAll('#findings .row').forEach(function (row) {
        const okText = !t || row.textContent.toLowerCase().indexOf(t) !== -1;
        const okSev = !s || row.getAttribute('data-severity') === s;
        row.style.display = okText && okSev ? '' : 'none';
      });
    }
    text.addEventListener('input', apply);
    sev.addEventListener('change', apply);
  </script>
</body>
</html>`;
}
