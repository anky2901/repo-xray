import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface CodeStyleContract extends Analyzer {
  readonly id: Extract<ModuleId, 'code-style'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './codestyle-analyzer';
