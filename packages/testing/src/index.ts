import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface TestIntelligenceContract extends Analyzer {
  readonly id: Extract<ModuleId, 'test-intelligence'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './testing-analyzer';
