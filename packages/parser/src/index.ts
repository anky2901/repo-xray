export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'unknown';

export interface ParsedFile {
  path: string;
  language: Language;
  lines: number;
  imports: string[];
  exports: string[];
  ast?: unknown;
}

export interface ASTParser {
  detect(filePath: string): Language;
  parse(filePath: string, source: string): Promise<ParsedFile>;
  supportedLanguages(): Language[];
}

export * from './parser';

