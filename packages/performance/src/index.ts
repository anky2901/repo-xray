import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface PerformanceContract extends Analyzer {
  readonly id: Extract<ModuleId, 'performance'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './performance-analyzer';
