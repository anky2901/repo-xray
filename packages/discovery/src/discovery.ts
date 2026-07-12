import * as fs from 'fs';
import * as path from 'path';
import { RepoMeta } from '@repo-xray/types';
import { XRayConfig, buildIgnoreFilter } from '@repo-xray/shared';

export function isBinaryBuffer(buf: Uint8Array): boolean {
  const checkLen = Math.min(buf.length, 512);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.json': 'JSON',
  '.css': 'CSS',
  '.html': 'HTML',
  '.sh': 'Shell',
  '.md': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
};

export function detectLanguagesAndCountFiles(
  workspacePath: string,
  ignoreFilter: (p: string) => boolean
): { languages: Record<string, number>; totalFiles: number; totalLines: number; sourceFiles: string[] } {
  let totalFiles = 0;
  let totalLines = 0;
  const langCounts: Record<string, number> = {};
  const sourceFiles: string[] = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (ignoreFilter(fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        totalFiles++;
        const ext = path.extname(entry.name).toLowerCase();
        let isText = false;
        let linesCount = 0;

        try {
          const fd = fs.openSync(fullPath, 'r');
          const buffer = new Uint8Array(512);
          const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
          fs.closeSync(fd);

          if (bytesRead > 0 && !isBinaryBuffer(buffer.subarray(0, bytesRead))) {
            isText = true;
            const content = fs.readFileSync(fullPath, 'utf-8');
            linesCount = content.split(/\r?\n/).length;
          }
        } catch {
          // unreadable file; skip
        }

        if (isText) {
          totalLines += linesCount;
          sourceFiles.push(fullPath);
          const lang = EXT_TO_LANG[ext] || 'Text';
          langCounts[lang] = (langCounts[lang] || 0) + 1;
        }
      }
    }
  }

  walk(workspacePath);

  const languages: Record<string, number> = {};
  const totalLangFiles = Object.values(langCounts).reduce((a, b) => a + b, 0);
  if (totalLangFiles > 0) {
    for (const [lang, count] of Object.entries(langCounts)) {
      languages[lang] = Math.round((count / totalLangFiles) * 100);
    }
  }

  return { languages, totalFiles, totalLines, sourceFiles };
}

export function detectFrameworks(workspacePath: string, sourceFiles: string[]): string[] {
  const frameworks = new Set<string>();

  const packageJsonFiles = sourceFiles.filter(f => path.basename(f) === 'package.json');
  for (const pkgPath of packageJsonFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = {
        ...(content.dependencies || {}),
        ...(content.devDependencies || {}),
      };
      if (deps['react']) frameworks.add('React');
      if (deps['next']) frameworks.add('Next.js');
      if (deps['vue']) frameworks.add('Vue');
      if (deps['express']) frameworks.add('Express');
      if (deps['nuxt']) frameworks.add('Nuxt.js');
      if (deps['svelte']) frameworks.add('Svelte');
      if (deps['angular']) frameworks.add('Angular');
      if (deps['tailwindcss']) frameworks.add('Tailwind');
    } catch {}
  }

  const pipFiles = sourceFiles.filter(f => ['requirements.txt', 'Pipfile'].includes(path.basename(f)));
  for (const pipPath of pipFiles) {
    try {
      const content = fs.readFileSync(pipPath, 'utf-8');
      if (content.includes('fastapi')) frameworks.add('FastAPI');
      if (content.includes('django')) frameworks.add('Django');
      if (content.includes('flask')) frameworks.add('Flask');
    } catch {}
  }

  const pomFiles = sourceFiles.filter(f => path.basename(f) === 'pom.xml');
  for (const pomPath of pomFiles) {
    try {
      const content = fs.readFileSync(pomPath, 'utf-8');
      if (content.includes('spring-boot') || content.includes('springframework')) frameworks.add('Spring');
    } catch {}
  }

  const gemFiles = sourceFiles.filter(f => path.basename(f) === 'Gemfile');
  for (const gemPath of gemFiles) {
    try {
      const content = fs.readFileSync(gemPath, 'utf-8');
      if (content.includes('rails')) frameworks.add('Rails');
    } catch {}
  }

  return Array.from(frameworks);
}

export function detectPackageManagers(workspacePath: string, sourceFiles: string[]): string[] {
  const managers = new Set<string>();

  if (fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'))) managers.add('pnpm');
  if (fs.existsSync(path.join(workspacePath, 'package-lock.json'))) managers.add('npm');
  if (fs.existsSync(path.join(workspacePath, 'yarn.lock'))) managers.add('yarn');
  if (fs.existsSync(path.join(workspacePath, 'bun.lockb')) || fs.existsSync(path.join(workspacePath, 'bun.lock'))) managers.add('bun');
  if (fs.existsSync(path.join(workspacePath, 'requirements.txt')) || fs.existsSync(path.join(workspacePath, 'Pipfile')) || fs.existsSync(path.join(workspacePath, 'poetry.lock'))) {
    managers.add('pip');
  }
  if (fs.existsSync(path.join(workspacePath, 'Cargo.toml')) || fs.existsSync(path.join(workspacePath, 'Cargo.lock'))) {
    managers.add('cargo');
  }
  if (fs.existsSync(path.join(workspacePath, 'go.mod')) || fs.existsSync(path.join(workspacePath, 'go.sum'))) {
    managers.add('go');
  }
  if (fs.existsSync(path.join(workspacePath, 'pom.xml'))) {
    managers.add('maven');
  }
  if (fs.existsSync(path.join(workspacePath, 'build.gradle'))) {
    managers.add('gradle');
  }

  const fileNames = sourceFiles.map(f => path.basename(f));

  if (fileNames.includes('pnpm-lock.yaml')) managers.add('pnpm');
  if (fileNames.includes('package-lock.json')) managers.add('npm');
  if (fileNames.includes('yarn.lock')) managers.add('yarn');
  if (fileNames.includes('package.json')) managers.add('npm');

  if (fileNames.includes('requirements.txt') || fileNames.includes('Pipfile') || fileNames.includes('poetry.lock')) {
    managers.add('pip');
  }
  if (fileNames.includes('Cargo.toml') || fileNames.includes('Cargo.lock')) {
    managers.add('cargo');
  }
  if (fileNames.includes('go.mod') || fileNames.includes('go.sum')) {
    managers.add('go');
  }
  if (fileNames.includes('pom.xml')) {
    managers.add('maven');
  }
  if (fileNames.includes('build.gradle')) {
    managers.add('gradle');
  }

  return Array.from(managers);
}

export function detectBuildSystems(sourceFiles: string[]): string[] {
  const systems = new Set<string>();
  const fileNames = sourceFiles.map(f => path.basename(f));

  if (fileNames.includes('webpack.config.js') || fileNames.includes('webpack.config.ts')) systems.add('webpack');
  if (fileNames.includes('vite.config.js') || fileNames.includes('vite.config.ts')) systems.add('vite');
  if (fileNames.includes('rollup.config.js') || fileNames.includes('rollup.config.ts')) systems.add('rollup');
  if (fileNames.includes('esbuild.config.js') || fileNames.includes('esbuild.config.ts')) systems.add('esbuild');
  if (fileNames.includes('tsconfig.json')) systems.add('tsc');
  if (fileNames.includes('Makefile') || fileNames.includes('makefile')) systems.add('make');

  return Array.from(systems);
}

export function detectEntrypoints(workspacePath: string, sourceFiles: string[]): string[] {
  const entrypoints = new Set<string>();

  const packageJsonFiles = sourceFiles.filter(f => path.basename(f) === 'package.json');
  for (const pkgPath of packageJsonFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (content.main) {
        const resolved = path.join(path.dirname(pkgPath), content.main);
        if (fs.existsSync(resolved)) {
          entrypoints.add(path.relative(workspacePath, resolved).replace(/\\/g, '/'));
        }
      }
    } catch {}
  }

  const standardNames = [
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'src/main.tsx',
    'src/main.jsx',
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'main.py',
    'app.py',
    'app.js',
    'app.ts',
    'server.js',
    'server.ts',
    'src/main.rs',
    'main.go',
    'cmd/main.go',
  ];

  for (const name of standardNames) {
    const full = path.join(workspacePath, name);
    if (fs.existsSync(full)) {
      entrypoints.add(name.replace(/\\/g, '/'));
    }
  }

  const dockerfile = sourceFiles.find(f => path.basename(f).toLowerCase() === 'dockerfile');
  if (dockerfile) {
    try {
      const content = fs.readFileSync(dockerfile, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('CMD ') || line.trim().startsWith('ENTRYPOINT ')) {
          entrypoints.add(path.relative(workspacePath, dockerfile).replace(/\\/g, '/'));
          break;
        }
      }
    } catch {}
  }

  return Array.from(entrypoints);
}

export function detectArchitectureStyle(workspacePath: string, sourceFiles: string[]): string {
  const relativePaths = sourceFiles.map(f => path.relative(workspacePath, f).replace(/\\/g, '/'));

  const packageJsonCount = relativePaths.filter(p => p.endsWith('package.json')).length;
  const pnpmWorkspaceExists = fs.existsSync(path.join(workspacePath, 'pnpm-workspace.yaml'));
  if (packageJsonCount > 2 || pnpmWorkspaceExists) {
    return 'monorepo/workspace';
  }

  const hasMVC = relativePaths.some(p => p.includes('controllers/')) &&
                 relativePaths.some(p => p.includes('models/')) &&
                 relativePaths.some(p => p.includes('views/'));
  if (hasMVC) return 'MVC';

  const hasClean = relativePaths.some(p => p.includes('domain/')) &&
                   relativePaths.some(p => p.includes('infrastructure/')) &&
                   relativePaths.some(p => p.includes('application/'));
  if (hasClean) return 'Clean/Hexagonal';

  const hasGoStd = relativePaths.some(p => p.startsWith('cmd/')) &&
                   (relativePaths.some(p => p.startsWith('pkg/')) || relativePaths.some(p => p.startsWith('internal/')));
  if (hasGoStd) return 'Go standard layout';

  const hasFSD = relativePaths.some(p => p.includes('features/'));
  if (hasFSD) return 'Feature-sliced';

  // Monolith heuristic: few files, one holds >80% of lines.
  if (sourceFiles.length > 0 && sourceFiles.length <= 10) {
    let maxLines = 0;
    let totalLines = 0;
    for (const file of sourceFiles) {
      try {
        const lines = fs.readFileSync(file, 'utf-8').split('\n').length;
        totalLines += lines;
        if (lines > maxLines) maxLines = lines;
      } catch {}
    }
    if (totalLines > 0 && maxLines / totalLines > 0.8) {
      return 'Monolith';
    }
  }

  return 'Standard single project';
}

export function performDiscovery(workspacePath: string, config: XRayConfig): RepoMeta {
  const ignoreFilter = buildIgnoreFilter(workspacePath, config);
  const startedAt = new Date().toISOString();
  
  const { languages, totalFiles, totalLines, sourceFiles } = detectLanguagesAndCountFiles(workspacePath, ignoreFilter);
  const frameworks = detectFrameworks(workspacePath, sourceFiles);
  const packageManagers = detectPackageManagers(workspacePath, sourceFiles);
  
  const completedAt = new Date().toISOString();
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

  return {
    name: path.basename(workspacePath),
    source: 'local',
    languages,
    frameworks,
    packageManagers,
    totalFiles,
    totalLines,
    runtime: {
      startedAt,
      completedAt,
      durationMs,
    },
  };
}
