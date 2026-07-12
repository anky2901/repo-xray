import type { Analyzer, ScanContext, Finding, ModuleId } from '@repo-xray/types';

export interface SecurityVulnerability {
  cwe?: string;
  cve?: string;
  description: string;
  file: string;
  line?: number;
  remediation: string;
}

export interface SecurityAnalyzer extends Analyzer {
  readonly id: Extract<ModuleId, 'security'>;
  findVulnerabilities(context: ScanContext): Promise<SecurityVulnerability[]>;
  scan(context: ScanContext): Promise<Finding[]>;
}

export * from './security-analyzer';

