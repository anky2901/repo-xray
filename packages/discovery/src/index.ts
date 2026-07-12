import type { RepoMeta } from '@repo-xray/types';

export type SourceKind = 'github-url' | 'local-path' | 'zip-archive';

export interface DiscoveryResult {
  sourceKind: SourceKind;
  resolvedPath: string;
  meta: RepoMeta;
}

export interface RepoDiscovery {
  detect(source: string): SourceKind;
  resolve(source: string): Promise<DiscoveryResult>;
}

export * from './discovery';

