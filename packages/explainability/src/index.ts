import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface ExplainabilityReport {
  complexity: number;
  documentationCoverage: number;
  readabilityScore: number;
  suggestions: string[];
}

export interface ExplainabilityAnalyzer extends Analyzer {
  readonly id: Extract<ModuleId, 'explainability'>;
  buildReport(context: ScanContext): Promise<ExplainabilityReport>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './explainability-analyzer';

