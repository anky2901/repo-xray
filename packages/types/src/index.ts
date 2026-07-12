export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type ModuleId =
  | 'repo-understanding'
  | 'architecture'
  | 'security'
  | 'code-style'
  | 'maintainability'
  | 'business'
  | 'git'
  | 'performance'
  | 'adoption'
  | 'autofix'
  | 'explainability'
  | 'export'
  | 'prompts'
  | 'vuln-fix'
  | 'test-intelligence'
  | 'dependency'
  | 'release'
  | 'ci-health';

export interface Evidence {
  file: string;
  line?: number;
  lineEnd?: number;
  snippet?: string;
  link?: string;
}

export interface Finding {
  id: string;
  module: ModuleId;
  title: string;
  summary: string;
  severity: Severity;
  confidence: number;
  evidence: Evidence[];
  reasoning: string;
  reproducible: boolean;
  tags: string[];
}

export type ScanMode = 'quick' | 'deep' | 'paranoid' | 'ci';

export interface ScoreCard {
  overall: number;
  security: number;
  architecture: number;
  maintainability: number;
  testCoverage: number;
  releaseReadiness: number;
  dependency: number;
}

export interface RepoMeta {
  name: string;
  source: 'github' | 'local' | 'zip';
  languages: Record<string, number>;
  frameworks: string[];
  packageManagers: string[];
  totalFiles: number;
  totalLines: number;
  entrypoints?: string[];
  architectureStyle?: string;
  runtime: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
}

export interface ScanResult {
  schema: '1.0';
  scanId: string;
  repoId: string;
  mode: ScanMode;
  findings: Finding[];
  scores: ScoreCard;
  meta: RepoMeta;
}

export interface SimpleLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  hash: string;
  createdAt: string;
  expiresAt?: string;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ScanContext {
  workspacePath: string;
  repoMeta: RepoMeta;
  config: {
    output: {
      dir: string;
      formats: string[];
    };
    [key: string]: unknown;
  };
  cache: CacheStore;
  logger: SimpleLogger;
  mode: ScanMode;
  offline?: boolean;
  priorFindings?: Finding[];
}

export interface Analyzer {
  id: ModuleId;
  name: string;
  version: string;
  offline: boolean;
  requiresAI: boolean;
  register(): Promise<void>;
  scan(context: ScanContext): Promise<Finding[]>;
  exportReport(context: ScanContext, format: 'json' | 'markdown'): Promise<string>;
}
