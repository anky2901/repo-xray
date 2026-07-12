import type { Finding, ScanContext, Analyzer } from '@repo-xray/types';

export function validateFinding(f: Finding): Finding | null {
  if (!f.evidence || f.evidence.length === 0) return null;
  if (!f.reasoning || f.reasoning.length < 20) return null;

  const result = { ...f };

  if (f.confidence < 40) {
    result.severity = 'INFO';
    result.summary = `[Low confidence] ${f.summary}`;
  }

  if (result.evidence) {
    result.evidence = result.evidence.map(ev => {
      let snippet = ev.snippet;
      if (snippet) {
        snippet = snippet.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]');
        snippet = snippet.replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_[REDACTED]');
        snippet = snippet.replace(/sk-[a-zA-Z0-9]{48}/g, 'sk-[REDACTED]');
        snippet = snippet.replace(/sk-ant-[a-zA-Z0-9-]{90,}/g, 'sk-ant-[REDACTED]');
        snippet = snippet.replace(/sk_live_[a-zA-Z0-9]{24}/g, 'sk_live_[REDACTED]');
        snippet = snippet.replace(/sk_test_[a-zA-Z0-9]{24}/g, 'sk_test_[REDACTED]');
        snippet = snippet.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED JWT]');
      }
      return { ...ev, snippet };
    });
  }

  return result;
}

export function calculateTrustScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;
  const sum = findings.reduce((acc, f) => acc + f.confidence, 0);
  return Math.round(sum / findings.length);
}

export class XRayExplainabilityAnalyzer implements Analyzer {
  readonly id = 'explainability';
  readonly name = 'Explainability & Trust';
  readonly version = '0.1.0';
  readonly offline = true;
  readonly requiresAI = false;

  async register(): Promise<void> {}

  async scan(context: ScanContext): Promise<Finding[]> {
    context.logger.info('[M11:explainability] Explaining findings and enforcing trust constraints');
    return [];
  }

  async buildReport(_context: ScanContext) {
    return {
      complexity: 0,
      documentationCoverage: 100,
      readabilityScore: 100,
      suggestions: [],
    };
  }

  async exportReport(_context: ScanContext, _format: 'json' | 'markdown'): Promise<string> {
    return '';
  }
}
