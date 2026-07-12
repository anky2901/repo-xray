import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../src/index';
import type { ScanResult, Finding } from '@repo-xray/sdk';

function makeResult(findings: Finding[] = []): ScanResult {
  return {
    schema: '1.0',
    scanId: 'scan',
    repoId: 'repo',
    mode: 'deep',
    findings,
    scores: { overall: 72, security: 60, architecture: 90, maintainability: 80, testCoverage: 55, releaseReadiness: 75, dependency: 88 },
    meta: {
      name: 'demo-app',
      source: 'local',
      languages: { TypeScript: 80, CSS: 20 },
      frameworks: ['Express'],
      packageManagers: ['npm'],
      totalFiles: 12,
      totalLines: 900,
      entrypoints: ['src/index.ts'],
      runtime: { startedAt: '', completedAt: '', durationMs: 0 },
    },
  };
}

describe('renderDashboard', () => {
  it('renders a full HTML document with scores and metadata', () => {
    const html = renderDashboard(makeResult());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('demo-app');
    expect(html).toContain('Overall');
    expect(html).toContain('72');
    expect(html).toContain('Maintainability');
  });

  it('renders findings as table rows', () => {
    const finding: Finding = {
      id: 'sec-1',
      module: 'security',
      title: 'Hardcoded API Key',
      summary: '',
      severity: 'CRITICAL',
      confidence: 95,
      evidence: [{ file: 'src/config.ts', line: 5 }],
      reasoning: 'secret',
      reproducible: true,
      tags: ['secret'],
    };
    const html = renderDashboard(makeResult([finding]));
    expect(html).toContain('Hardcoded API Key');
    expect(html).toContain('src/config.ts:5');
    expect(html).toContain('data-severity="CRITICAL"');
  });

  it('escapes HTML in finding content to prevent injection', () => {
    const finding: Finding = {
      id: 'x',
      module: 'security',
      title: '<script>alert(1)</script>',
      summary: '',
      severity: 'HIGH',
      confidence: 80,
      evidence: [{ file: 'a.ts' }],
      reasoning: 'r',
      reproducible: true,
      tags: [],
    };
    const html = renderDashboard(makeResult([finding]));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
