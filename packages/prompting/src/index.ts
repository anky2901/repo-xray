import type { ScanResult } from '@repo-xray/types';

export interface PromptVariable {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  variables: PromptVariable[];
  template: string;
}

export interface PromptEngine {
  listTemplates(): PromptTemplate[];
  render(templateId: string, result: ScanResult): Promise<string>;
  getTemplate(id: string): PromptTemplate | undefined;
}

export * from './prompt-generator';
