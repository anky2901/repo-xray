import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface DependencyVulnerability {
  packageName: string;
  installedVersion: string;
  patchedVersion?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cve?: string;
}

export interface DependencyAnalyzerContract extends Analyzer {
  readonly id: Extract<ModuleId, 'dependency'>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './dependency-analyzer';
