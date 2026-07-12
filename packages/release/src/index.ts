import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface ReleaseAnalyzerContract extends Analyzer {
  readonly id: Extract<ModuleId, 'release'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './release-analyzer';
export * from './readme-score';
