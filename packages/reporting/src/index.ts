import type { ScanResult } from '@repo-xray/types';

export type ReportFormat = 'markdown' | 'html' | 'json' | 'sarif' | 'pdf';

export interface ReportSection {
  title: string;
  content: string;
}

export interface ReportRenderer {
  format: ReportFormat;
  render(result: ScanResult): Promise<string>;
  sections(result: ScanResult): ReportSection[];
}

export * from './vuln-report';
export * from './adoption-report';
export * from './autofix-report';
export * from './dashboard';
