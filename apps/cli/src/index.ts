import { Command } from 'commander';
import {
  loadConfig,
  stableJson,
  stableArtifactJson,
  sortFindings,
  XRayPipeline,
  FileCache,
  logger,
} from '@repo-xray/sdk';
import { ScanResult, ScanMode, ScanStore, Severity } from '@repo-xray/sdk';
import { XRayCiAnalyzer } from '@repo-xray/ci';
import { XRayReleaseAnalyzer } from '@repo-xray/release';
import { XRayPromptGenerator } from '@repo-xray/prompting';
import { GitHubIngester } from '@repo-xray/ingestion';
import { performDiscovery } from '@repo-xray/discovery';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

program
  .name('xray')
  .description('Repo X-Ray: local-first repository intelligence platform')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan a repository (local path, GitHub URL, or zip) and persist a deterministic result')
  .argument('<source>', 'Source to scan (URL / path / zip)')
  .option('--mode <mode>', 'Scan mode: quick | deep | paranoid | ci', 'quick')
  .option('--output <dir>', 'Output directory for reports')
  .option('--offline', 'Use only cached data; skip live network lookups')
  .option('--ci', 'Machine-friendly output with CI exit codes')
  .option('--fail-on <severity>', 'In CI mode, exit non-zero when a finding at or above this severity exists')
  .action(async (source: string, options: { mode: ScanMode; output?: string; offline?: boolean; ci?: boolean; failOn?: string }) => {
    const overrides = options.output ? { output: { dir: options.output, formats: ['json'] as ('markdown' | 'html' | 'json' | 'pdf' | 'sarif')[] } } : {};
    const config = loadConfig(process.env, overrides);
    let mode = options.mode ?? 'quick';
    if (options.ci) mode = 'ci';

    if (!['quick', 'deep', 'paranoid', 'ci'].includes(mode)) {
      console.error(`Unsupported scan mode: ${mode}`);
      process.exit(1);
      return;
    }

    const cache = new FileCache(config.cache.dir);
    const pipeline = new XRayPipeline();

    let result: ScanResult;
    try {
      result = await pipeline.run({
        source,
        mode,
        modules: ['security', 'architecture', 'dependency', 'test-intelligence', 'release', 'ci-health'],
        config,
        cache,
        logger,
        offline: options.offline === true,
      });
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`Scan failed:`, error.stack || error);
      process.exit(1);
      return;
    }

    const store = new ScanStore(path.join(config.output.dir, 'xray.db'));
    try {
      store.saveScan({
        ...result,
        findings: sortFindings(result.findings),
      });
    } finally {
      store.close();
    }

    console.log(stableArtifactJson(result));

    if (options.ci) {
      const hasCritical = result.findings.some((f) => f.severity === 'CRITICAL');
      const hasHigh = result.findings.some((f) => f.severity === 'HIGH');

      if (options.failOn) {
        const threshold = options.failOn.toUpperCase() as Severity;
        if (SEVERITY_RANK[threshold] !== undefined) {
          const breached = result.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[threshold]);
          if (breached) {
            process.exit(hasCritical ? 3 : hasHigh ? 2 : 1);
            return;
          }
        }
      }

      if (hasCritical) {
        process.exit(3);
      } else if (hasHigh) {
        process.exit(2);
      }
    }
  });


program
  .command('release-check')
  .description('Run release-readiness checks (M17 + M18) on a fast path')
  .argument('<src>', 'Source to check (local path or GitHub URL)')
  .option('--output <dir>', 'Output directory for reports')
  .action(async (src: string, options: { output?: string }) => {
    const overrides = options.output ? { output: { dir: options.output, formats: ['json'] as ('markdown' | 'html' | 'json' | 'pdf' | 'sarif')[] } } : {};
    const config = loadConfig(process.env, overrides);
    const outputDir = config.output.dir;

    const cleanSource = src.trim();
    const isGit = cleanSource.includes('github.com');
    let workspacePath = cleanSource;
    let cleanup: (() => void) | null = null;

    try {
      if (isGit) {
        const ingester = new GitHubIngester({
          maxRepoSizeGb: config.scan.maxRepoSizeGb,
          cacheDir: config.cache.dir,
          outputDir,
        });
        workspacePath = await ingester.clone(cleanSource, config.github.authMode, config.github.token);
        cleanup = () => {
          try {
            fs.rmSync(workspacePath, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        };
      } else {
        const resolved = path.resolve(cleanSource);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          console.error(`Local path does not exist or is not a directory: ${resolved}`);
          process.exit(1);
          return;
        }
        workspacePath = resolved;
      }

      const repoMeta = performDiscovery(workspacePath, config);
      repoMeta.name = path.basename(cleanSource.replace(/\.git$/, '').replace(/\/$/, ''));

      const scanContext = {
        workspacePath,
        repoMeta,
        config,
        cache: new FileCache(config.cache.dir),
        logger,
        mode: 'ci' as ScanMode,
      };

      const ci = new XRayCiAnalyzer();
      const release = new XRayReleaseAnalyzer();
      const ciResult = ci.analyze(scanContext);
      const releaseResult = release.analyze(scanContext, ciResult.testsConfigured);

      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'RELEASE.md'), releaseResult.report, 'utf-8');
      fs.writeFileSync(path.join(outputDir, 'RELEASE_CHECKLIST.md'), releaseResult.checklist, 'utf-8');
      fs.writeFileSync(path.join(outputDir, 'CI_REPORT.md'), ciResult.report, 'utf-8');

      console.log(stableJson({
        repo: repoMeta.name,
        releaseScore: releaseResult.score,
        readmeScore: releaseResult.readmeScore.score,
        ciTestsConfigured: ciResult.testsConfigured,
        blockers: releaseResult.blockers,
        reports: ['RELEASE.md', 'RELEASE_CHECKLIST.md', 'CI_REPORT.md'],
      }));
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`release-check failed:`, error.message);
      process.exit(1);
    } finally {
      if (cleanup) cleanup();
    }
  });

program
  .command('prompts')
  .description('Generate AI prompts for a repository from extracted facts')
  .argument('<src>', 'Source to evaluate (local path or GitHub URL)')
  .option('--output <dir>', 'Output directory for prompt files')
  .option('--offline', 'Use only cached data; skip live network lookups')
  .action(async (src: string, options: { output?: string; offline?: boolean }) => {
    const overrides = options.output ? { output: { dir: options.output, formats: ['json'] as ('markdown' | 'html' | 'json' | 'pdf' | 'sarif')[] } } : {};
    const config = loadConfig(process.env, overrides);
    const cache = new FileCache(config.cache.dir);
    const pipeline = new XRayPipeline();

    let result: ScanResult;
    try {
      result = await pipeline.run({
        source: src,
        mode: 'deep',
        modules: ['security', 'architecture', 'dependency', 'test-intelligence', 'release', 'ci-health', 'prompts'],
        config,
        cache,
        logger,
        offline: options.offline === true,
      });
    } catch (err: unknown) {
      console.error(`prompts failed:`, (err as Error).message);
      process.exit(1);
      return;
    }

    const bundle = new XRayPromptGenerator().generate(src, result);
    console.log(stableJson({
      repo: result.meta.name,
      stack: bundle.facts.stack,
      architecture: bundle.facts.architecture,
      entrypoint: bundle.facts.entrypoint,
      files: Object.keys(bundle.files).sort(),
    }));
  });


program
  .command('compare')
  .description('Compare two stored scan results')
  .argument('<id1>', 'First scan ID')
  .argument('<id2>', 'Second scan ID')
  .action((id1: string, id2: string) => {
    const config = loadConfig();
    const store = new ScanStore(path.join(config.output.dir, 'xray.db'));
    try {
      const diff = store.compareScans(id1, id2);
      if (diff.error) {
        console.error(diff.error);
        process.exit(1);
        return;
      }
      console.log(stableJson({
        ...diff,
        addedFindings: sortFindings(diff.addedFindings),
        removedFindings: sortFindings(diff.removedFindings),
      }));
    } finally {
      store.close();
    }
  });

program
  .command('history')
  .description('List past scans for a repository')
  .argument('[repo]', 'Repo ID (optional)')
  .action((repo?: string) => {
    const config = loadConfig();
    const store = new ScanStore(path.join(config.output.dir, 'xray.db'));
    try {
      if (!repo) {
        console.error('A repo ID is required.');
        process.exit(1);
        return;
      }

      console.log(stableJson(store.listScans(repo)));
    } finally {
      store.close();
    }
  });

program
  .command('config')
  .description('Show current validated configuration')
  .action(() => {
    try {
      const config = loadConfig();
      console.log(stableJson(config));
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`Error loading config: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Run environment diagnostics (node, pnpm, sqlite, cache, permissions, git, disk)')
  .action(async () => {
    console.log(`Running doctor checks...`);

    const nodeVer = process.version;
    const nodeMajor = parseInt(nodeVer.slice(1).split('.')[0], 10);
    const nodeOk = nodeMajor >= 18;
    console.log(`node: ${nodeVer} (${nodeOk ? 'OK' : 'FAIL, needs >= 18'})`);

    let pnpmOk = false;
    let pnpmVer = 'Not found';
    try {
      pnpmVer = execSync('pnpm -v').toString().trim();
      pnpmOk = true;
    } catch { /* not installed */ }
    console.log(`pnpm: ${pnpmVer} (${pnpmOk ? 'OK' : 'FAIL'})`);

    let sqliteOk = false;
    try {
      const { default: Database } = await import('better-sqlite3');
      const testDbPath = path.join(process.cwd(), '.xray-reports/doctor-test.db');
      const testDbDir = path.dirname(testDbPath);
      if (!fs.existsSync(testDbDir)) {
        fs.mkdirSync(testDbDir, { recursive: true });
      }
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY)');
      db.close();
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      sqliteOk = true;
    } catch (err: unknown) {
      console.log(`SQLite doctor check failed: ${(err as Error).message}`);
    }
    console.log(`sqlite (better-sqlite3): ${sqliteOk ? 'OK' : 'FAIL'}`);

    let cacheOk = false;
    try {
      const cacheDir = '.xray-cache';
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const testFile = path.join(cacheDir, 'doctor-test.json');
      fs.writeFileSync(testFile, '{}', 'utf-8');
      fs.unlinkSync(testFile);
      cacheOk = true;
    } catch (err: unknown) {
      console.log(`Cache doctor check failed: ${(err as Error).message}`);
    }
    console.log(`cache: ${cacheOk ? 'OK' : 'FAIL'}`);

    let permissionsOk = false;
    try {
      fs.accessSync(process.cwd(), fs.constants.R_OK | fs.constants.W_OK);
      permissionsOk = true;
    } catch (err: unknown) {
      console.log(`Permissions doctor check failed: ${(err as Error).message}`);
    }
    console.log(`permissions: ${permissionsOk ? 'OK' : 'FAIL'}`);

    let gitOk = false;
    let gitVer = 'Not found';
    let gitExe = 'Unknown';
    try {
      gitVer = execSync('git --version').toString().trim();
      gitExe = execSync('where git').toString().trim().split('\r\n')[0];
      gitOk = true;
    } catch (err: unknown) {
      console.log(`Git doctor check failed: ${(err as Error).message}`);
    }
    console.log(`git installed: ${gitOk ? 'YES' : 'NO'}`);
    console.log(`git version: ${gitVer}`);
    console.log(`git executable: ${gitExe}`);

    let diskOk = false;
    let diskFree = 'Unknown';
    try {
      const drive = process.cwd().slice(0, 2);
      const psCmd = `Get-PSDrive ${drive[0]} | Select-Object Free | ConvertTo-Json`;
      const psOut = execSync(`powershell -Command "${psCmd}"`).toString().trim();
      const psData = JSON.parse(psOut);
      if (psData && psData.Free !== undefined) {
        const freeGb = (psData.Free / (1024 * 1024 * 1024)).toFixed(2);
        diskFree = `${freeGb} GB free`;
        diskOk = psData.Free > 1024 * 1024 * 1024;
      }
    } catch (err: unknown) {
      console.log(`Disk doctor check failed: ${(err as Error).message}`);
    }
    console.log(`disk space: ${diskFree} (${diskOk ? 'OK' : 'WARNING, low disk space'})`);

    const allOk = nodeOk && pnpmOk && sqliteOk && cacheOk && permissionsOk && gitOk && diskOk;
    if (!allOk) {
      console.log('\n❌ Doctor check failed. Fix the issues listed above.');
      process.exit(1);
    } else {
      console.log('\n✅ Doctor check passed. Environment is healthy.');
    }
  });

if (process.env.NODE_ENV !== 'test') {
  program.parse(process.argv);
}

export { program };
