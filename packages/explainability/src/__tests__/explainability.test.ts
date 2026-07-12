import { describe, test, expect } from 'vitest';
import { validateFinding, calculateTrustScore } from '../explainability-analyzer';
import { Finding } from '@repo-xray/types';

describe('M11 Explainability + Trust Layer', () => {
  const baseFinding: Finding = {
    id: 'f1',
    module: 'security',
    title: 'Secret Leak',
    summary: 'A secret was found',
    severity: 'HIGH',
    confidence: 85,
    evidence: [{ file: 'src/config.ts', line: 12, snippet: 'const key = "sk-1234567890abcdef1234567890abcdef1234567890abcdef"' }],
    reasoning: 'Found an API key matching a known service key signature. Hardcoded keys must be avoided.',
    reproducible: true,
    tags: ['secret'],
  };

  test('keeps valid finding and masks secrets in evidence', () => {
    const validated = validateFinding(baseFinding);
    expect(validated).not.toBeNull();
    expect(validated?.evidence[0].snippet).toBe('const key = "sk-[REDACTED]"');
  });

  test('downgrades severity to INFO if confidence < 40', () => {
    const lowConfidence = { ...baseFinding, confidence: 35 };
    const validated = validateFinding(lowConfidence);
    expect(validated).not.toBeNull();
    expect(validated?.severity).toBe('INFO');
    expect(validated?.summary).toContain('[Low confidence]');
  });

  test('drops finding if no evidence is provided', () => {
    const noEvidence = { ...baseFinding, evidence: [] };
    const validated = validateFinding(noEvidence);
    expect(validated).toBeNull();
  });

  test('drops finding if reasoning is too short', () => {
    const shortReasoning = { ...baseFinding, reasoning: 'Too short' };
    const validated = validateFinding(shortReasoning);
    expect(validated).toBeNull();
  });

  test('calculates correct trust score', () => {
    const findings = [
      { ...baseFinding, confidence: 80 },
      { ...baseFinding, confidence: 90 },
    ];
    const score = calculateTrustScore(findings);
    expect(score).toBe(85);
  });
});
