import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';
import type { CiProvider } from './ci-analyzer';

export interface CiHealthReport {
  provider: CiProvider;
  workflowsAnalyzed: number;
  testsConfigured: boolean;
}

export interface CiAnalyzer extends Analyzer {
  readonly id: Extract<ModuleId, 'ci-health'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './ci-analyzer';
