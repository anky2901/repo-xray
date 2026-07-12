import type { ScanResult } from '@repo-xray/types';

export type ExportFormat = 'json' | 'markdown' | 'html' | 'sarif' | 'pdf';

export interface ExportOptions {
  format: ExportFormat;
  outputPath: string;
  includeEvidence?: boolean;
  extraReports?: Record<string, string>;
}

export interface ExportTarget {
  render(result: ScanResult, options: ExportOptions): Promise<void>;
  supportedFormats(): ExportFormat[];
}

export * from './exporter';

