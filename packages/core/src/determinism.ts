import { Finding } from '@repo-xray/types';
import * as path from 'path';
import * as crypto from 'crypto';

export interface DeterministicMode {
  normalizePaths: true;
  normalizeTimestamps: true;
  normalizeIds: true;
  sortKeys: true;
  sortCollections: true;
}

export const DETERMINISTIC_MODE: DeterministicMode = {
  normalizePaths: true,
  normalizeTimestamps: true,
  normalizeIds: true,
  sortKeys: true,
  sortCollections: true,
};

function normalizePathValue(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return normalized.replace(/\/+$/, '');
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === 'string' && /[\\/]/.test(value)) {
    return normalizePathValue(value);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      normalized[key] = normalizeValue(record[key]);
    }
    return normalized;
  }

  return value;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    return [
      left.module.localeCompare(right.module),
      left.severity.localeCompare(right.severity),
      left.title.localeCompare(right.title),
      left.id.localeCompare(right.id),
    ].find((result) => result !== 0) ?? 0;
  });
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value), null, 2);
}

export function stripRuntimeMetadata<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripRuntimeMetadata(entry)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'runtime') {
      continue;
    }
    next[key] = stripRuntimeMetadata(entry);
  }
  return next as T;
}

export function createDeterministicId(parts: unknown[]): string {
  return crypto.createHash('sha256').update(stableJson(parts)).digest('hex');
}

export function stableArtifactJson(value: unknown): string {
  return stableJson(stripRuntimeMetadata(value));
}
