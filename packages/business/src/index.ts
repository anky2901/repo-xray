import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface BusinessContract extends Analyzer {
  readonly id: Extract<ModuleId, 'business'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './business-analyzer';
