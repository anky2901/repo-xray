import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@repo-xray/shared': path.resolve(__dirname, 'shared/src/index.ts'),
      '@repo-xray/types': path.resolve(__dirname, 'packages/types/src/index.ts'),
      '@repo-xray/cache': path.resolve(__dirname, 'packages/cache/src/index.ts'),
      '@repo-xray/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@repo-xray/sdk': path.resolve(__dirname, 'packages/sdk/src/index.ts'),
      '@repo-xray/storage': path.resolve(__dirname, 'packages/storage/src/index.ts'),
      '@repo-xray/security': path.resolve(__dirname, 'packages/security/src/index.ts'),
      '@repo-xray/architecture': path.resolve(__dirname, 'packages/architecture/src/index.ts'),
      '@repo-xray/explainability': path.resolve(__dirname, 'packages/explainability/src/index.ts'),
      '@repo-xray/export': path.resolve(__dirname, 'packages/export/src/index.ts'),
      '@repo-xray/discovery': path.resolve(__dirname, 'packages/discovery/src/index.ts'),
      '@repo-xray/parser': path.resolve(__dirname, 'packages/parser/src/index.ts'),
      '@repo-xray/ingestion': path.resolve(__dirname, 'packages/ingestion/src/index.ts'),
      '@repo-xray/dependency': path.resolve(__dirname, 'packages/dependency/src/index.ts'),
      '@repo-xray/testing': path.resolve(__dirname, 'packages/testing/src/index.ts'),
      '@repo-xray/release': path.resolve(__dirname, 'packages/release/src/index.ts'),
      '@repo-xray/ci': path.resolve(__dirname, 'packages/ci/src/index.ts'),
      '@repo-xray/prompting': path.resolve(__dirname, 'packages/prompting/src/index.ts'),
      '@repo-xray/reporting': path.resolve(__dirname, 'packages/reporting/src/index.ts'),
      '@repo-xray/maintainability': path.resolve(__dirname, 'packages/maintainability/src/index.ts'),
      '@repo-xray/performance': path.resolve(__dirname, 'packages/performance/src/index.ts'),
      '@repo-xray/git': path.resolve(__dirname, 'packages/git/src/index.ts'),
      '@repo-xray/codestyle': path.resolve(__dirname, 'packages/codestyle/src/index.ts'),
      '@repo-xray/business': path.resolve(__dirname, 'packages/business/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.xray-cache/**',
      '**/.xray-reports/**'
    ],
  },
});
