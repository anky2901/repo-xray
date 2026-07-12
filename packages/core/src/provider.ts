import * as fs from 'fs';
import * as path from 'path';
import { FeatureDisabledError } from './phase';

export class LocalProvider {
  async clone(targetPath: string, _options?: unknown): Promise<{ path: string }> {
    const resolved = path.resolve(targetPath);
    return { path: resolved };
  }

  async getMetadata(targetPath: string): Promise<{ name: string; source: 'local' }> {
    const resolvedPath = path.resolve(targetPath);
    const packageJsonPath = path.join(resolvedPath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      return {
        name: path.basename(resolvedPath),
        source: 'local',
      };
    }

    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content) as { name?: string };
      return {
        name: packageJson.name || path.basename(resolvedPath),
        source: 'local',
      };
    } catch {
      return {
        name: path.basename(resolvedPath),
        source: 'local',
      };
    }
  }
}

export class GitHubProvider {
  async clone(_repo: string, _options?: unknown): Promise<never> {
    throw new FeatureDisabledError('GitHub integration is disabled in this phase.');
  }

  async getMetadata(_repo: string): Promise<never> {
    throw new FeatureDisabledError('GitHub integration is disabled in this phase.');
  }
}
