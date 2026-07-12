import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface GitContract extends Analyzer {
  readonly id: Extract<ModuleId, 'git'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './git-analyzer';
