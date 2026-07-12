import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface ArchitectureIssue {
  type: 'circular-dependency' | 'god-class' | 'layer-violation' | 'coupling';
  description: string;
  affectedPaths: string[];
}

export interface ArchitectureAnalyzer extends Analyzer {
  readonly id: Extract<ModuleId, 'architecture'>;
  detectIssues(context: ScanContext): Promise<ArchitectureIssue[]>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './architecture-analyzer';

