import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface MaintainabilityContract extends Analyzer {
  readonly id: Extract<ModuleId, 'maintainability'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './maintainability-analyzer';
