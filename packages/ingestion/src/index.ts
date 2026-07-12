import type { RepoMeta } from '@repo-xray/types';

export type IngestionSourceKind = 'local' | 'github' | 'zip';

export interface IngestionSource {
  kind: IngestionSourceKind;
  uri: string;
  auth?: string;
}

export interface IngestionResult {
  workspacePath: string;
  meta: RepoMeta;
  cleanupFn: () => Promise<void>;
}

export interface Ingester {
  ingest(source: IngestionSource): Promise<IngestionResult>;
  supports(source: IngestionSource): boolean;
}

export * from './github-provider';

