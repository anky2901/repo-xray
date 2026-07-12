import * as fs from 'fs';
import * as path from 'path';
import { XRayConfig } from './config';

export type IgnoreFilter = (filePath: string) => boolean;

function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').trim();
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexStr, 'i');
}

export function buildIgnoreFilter(workspacePath: string, config: XRayConfig): IgnoreFilter {
  const normalizedWorkspace = path.resolve(workspacePath).replace(/^[A-Za-z]:/, m => m.toLowerCase());
  const ignorePatterns: string[] = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '__pycache__',
    'vendor',
    '.cache',
    '.xray-cache',
    '.xray-reports',
    'doctor-test.db'
  ];

  if (config.ignore.useGitignore) {
    const gitignorePath = path.join(normalizedWorkspace, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            ignorePatterns.push(trimmed);
          }
        }
      } catch {
        // Ignore file errors
      }
    }
  }

  const xrayignorePath = path.join(normalizedWorkspace, '.xrayignore');
  if (fs.existsSync(xrayignorePath)) {
    try {
      const content = fs.readFileSync(xrayignorePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          ignorePatterns.push(trimmed);
        }
      }
    } catch {
      // Ignore file errors
    }
  }

  if (config.ignore.patterns && config.ignore.patterns.length > 0) {
    ignorePatterns.push(...config.ignore.patterns);
  }

  const compiledPatterns = ignorePatterns
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      let cleanPattern = p.replace(/\\/g, '/');
      if (cleanPattern.endsWith('/') && cleanPattern.length > 1) {
        cleanPattern = cleanPattern.slice(0, -1);
      }
      if (!cleanPattern.includes('*')) {
        return {
          match: (rel: string) => {
            const normalizedRel = rel.replace(/\\/g, '/');
            return normalizedRel === cleanPattern ||
                   normalizedRel.startsWith(cleanPattern + '/') ||
                   normalizedRel.split('/').includes(cleanPattern);
          }
        };
      }
      const regex = globToRegex(cleanPattern);
      return {
        match: (rel: string) => {
          const normalizedRel = rel.replace(/\\/g, '/');
          return regex.test(normalizedRel) ||
                 normalizedRel.split('/').some(part => regex.test(part));
        }
      };
    });

  return (filePath: string) => {
    const absFilePath = path.resolve(filePath).replace(/^[A-Za-z]:/, m => m.toLowerCase());
    let relPath = path.relative(normalizedWorkspace, absFilePath);
    relPath = relPath.replace(/\\/g, '/');
    if (!relPath) return false;

    for (const pat of compiledPatterns) {
      if (pat.match(relPath)) {
        return true;
      }
    }
    return false;
  };
}
