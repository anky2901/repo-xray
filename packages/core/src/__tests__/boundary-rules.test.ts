import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Monorepo Package Boundary Rules', () => {
  const rootDir = path.resolve(__dirname, '../../../../');

  function walk(dir: string, ext: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir)) {
      if (['node_modules', 'dist', '__tests__', 'test', 'tests', 'fixtures'].includes(entry)) continue;
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        results.push(...walk(full, ext));
      } else if (full.endsWith(ext)) {
        results.push(full);
      }
    }
    return results;
  }

  function getPackageJsonFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir)) {
      if (['node_modules', 'dist', '__tests__', 'test', 'tests', 'fixtures'].includes(entry)) continue;
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        results.push(...getPackageJsonFiles(full));
      } else if (entry === 'package.json') {
        results.push(full);
      }
    }
    return results;
  }

  function extractImports(source: string): string[] {
    const pattern = /(?:import|from)\s+['"](@repo-xray\/[^'"]+)['"]/g;
    const imports: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      imports.push(match[1]);
    }
    return imports;
  }

  it('should enforce architectural boundaries in package.json dependencies', () => {
    const pkgJsons = getPackageJsonFiles(rootDir);
    expect(pkgJsons.length).toBeGreaterThan(0);

    for (const pkgPath of pkgJsons) {
      if (path.resolve(pkgPath) === path.resolve(path.join(rootDir, 'package.json'))) continue;

      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const name = content.name;
      if (!name || typeof name !== 'string') continue;
      const allDeps = [
        ...Object.keys(content.dependencies ?? {}),
        ...Object.keys(content.devDependencies ?? {}),
      ];

      // shared cannot depend on apps, sdk, or packages
      if (name === '@repo-xray/shared') {
        for (const dep of allDeps) {
          expect(dep, `shared must not depend on ${dep}`).not.toMatch(/^@repo-xray\/(?!shared$).+/);
        }
      }

      // packages (non-sdk, non-shared, non-app) cannot depend on apps or sdk
      if (
        name.startsWith('@repo-xray/') &&
        !['@repo-xray/sdk', '@repo-xray/shared', '@repo-xray/cli', '@repo-xray/web'].includes(name)
      ) {
        for (const dep of allDeps) {
          expect(dep, `${name} must not depend on ${dep}`).not.toMatch(/^@repo-xray\/(cli|web|sdk)$/);
        }
      }

      // sdk cannot depend on apps
      if (name === '@repo-xray/sdk') {
        for (const dep of allDeps) {
          expect(dep, `sdk must not depend on ${dep}`).not.toMatch(/^@repo-xray\/(cli|web)$/);
        }
      }

      // apps must depend on sdk instead of importing internal layers directly
      if (['@repo-xray/cli', '@repo-xray/web'].includes(name)) {
        for (const dep of allDeps) {
          expect(dep, `${name} must not depend on ${dep}`).not.toMatch(/^@repo-xray\/(core|shared|storage|types|cache)$/);
        }
      }
    }
  });

  it('should enforce boundary rules in TypeScript source imports', () => {
    const packagesDir = path.join(rootDir, 'packages');
    const sharedDir = path.join(rootDir, 'shared');

    const packagesSrcFiles = walk(packagesDir, '.ts').filter((f) => !f.endsWith('.test.ts'));
    const sharedSrcFiles = walk(sharedDir, '.ts').filter((f) => !f.endsWith('.test.ts'));

    const appsDir = path.join(rootDir, 'apps');
    const appsSrcFiles = walk(appsDir, '.ts').filter((f) => !f.endsWith('.test.ts'));
    const forbiddenForPackages = /^@repo-xray\/(cli|web|sdk)$/;
    const forbiddenForShared = /^@repo-xray\/.+/;
    const forbiddenForApps = /^@repo-xray\/(core|shared|storage|types|cache)$/;

    for (const file of packagesSrcFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      const pkgMatch = file.match(/packages[\\/]([^\\/]+)/);
      const pkgName = pkgMatch ? pkgMatch[1] : 'unknown';
      if (pkgName === 'sdk') continue; // sdk re-exports are expected

      for (const imp of extractImports(source)) {
        expect(imp, `${file} must not import ${imp}`).not.toMatch(forbiddenForPackages);
      }
    }

    for (const file of sharedSrcFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const imp of extractImports(source)) {
        expect(imp, `${file} must not import ${imp}`).not.toMatch(forbiddenForShared);
      }
    }

    for (const file of appsSrcFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const imp of extractImports(source)) {
        expect(imp, `${file} must not import ${imp}`).not.toMatch(forbiddenForApps);
      }
    }
  });
});
