import { Finding, ScanResult, ModuleId, RepoMeta, ScanMode, ScoreCard, ScanContext, Analyzer } from '@repo-xray/types';
import { XRayConfig, Logger, buildIgnoreFilter } from '@repo-xray/shared';
import { CacheStore } from '@repo-xray/cache';
import { GitHubIngester } from '@repo-xray/ingestion';
import { performDiscovery, detectEntrypoints, detectArchitectureStyle } from '@repo-xray/discovery';
import { parseFile } from '@repo-xray/parser';
import { XRaySecurityAnalyzer } from '@repo-xray/security';
import { XRayArchitectureAnalyzer } from '@repo-xray/architecture';
import { validateFinding } from '@repo-xray/explainability';
import { XRayExportTarget } from '@repo-xray/export';
import { XRayDependencyAnalyzer } from '@repo-xray/dependency';
import { XRayTestingAnalyzer } from '@repo-xray/testing';
import { XRayCiAnalyzer } from '@repo-xray/ci';
import { XRayReleaseAnalyzer } from '@repo-xray/release';
import { XRayPromptGenerator } from '@repo-xray/prompting';
import { generateVulnReport, generateAdoptionReport, generateAutofixReport, renderDashboard } from '@repo-xray/reporting';
import { XRayBusinessAnalyzer } from '@repo-xray/business';
import { XRayMaintainabilityAnalyzer } from '@repo-xray/maintainability';
import { XRayPerformanceAnalyzer } from '@repo-xray/performance';
import { XRayGitAnalyzer } from '@repo-xray/git';
import { XRayCodeStyleAnalyzer } from '@repo-xray/codestyle';

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import AdmZip from 'adm-zip';

export interface Pipeline {
  run(input: PipelineInput): Promise<ScanResult>;
}

export interface PipelineInput {
  source: string;
  mode: ScanMode;
  modules: ModuleId[];
  config: XRayConfig;
  cache: CacheStore;
  logger: Logger;
  offline?: boolean;
}

export interface PipelineContext {
  input: PipelineInput;
  repoMeta?: RepoMeta;
  findings: Finding[];
  workspacePath?: string;
}

export interface PipelineStage {
  name: string;
  execute(ctx: PipelineContext): Promise<PipelineContext>;
}

export type { ScanContext, Analyzer };

export interface WorkspaceResult {
  path: string;
  source: 'github' | 'local' | 'zip';
  meta: RepoMetadata;
}

export interface RepoMetadata {
  name: string;
  source: 'github' | 'local' | 'zip';
}

export interface CloneOptions {
  auth?: string;
  depth?: number;
}

export interface SourceProvider {
  id: string;
  clone(target: string, options: CloneOptions): Promise<WorkspaceResult>;
  getMetadata(target: string): Promise<RepoMetadata>;
}

function copyDirSync(src: string, dest: string, ignoreFilter: (p: string) => boolean) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (ignoreFilter(srcPath)) continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, ignoreFilter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export class XRayPipeline implements Pipeline {
  async run(input: PipelineInput): Promise<ScanResult> {
    const timings: Record<string, number> = {};
    const startedAt = new Date().toISOString();
    let workspacePath = '';
    let isTempWorkspace = false;
    let sourceKind: 'local' | 'github' | 'zip' = 'local';
    const startOverall = Date.now();

    const startAcq = Date.now();
    const cleanSource = input.source.trim();
    const isGit = cleanSource.startsWith('https://github.com/') || cleanSource.startsWith('git@github.com:') || cleanSource.includes('github.com');
    const isZip = cleanSource.endsWith('.zip');

    const tempClonesDir = path.join(input.config.cache.dir, 'temp-clones');
    if (!fs.existsSync(tempClonesDir)) {
      fs.mkdirSync(tempClonesDir, { recursive: true });
    }

    if (isGit) {
      sourceKind = 'github';
      const ingester = new GitHubIngester({
        maxRepoSizeGb: input.config.scan.maxRepoSizeGb,
        cacheDir: input.config.cache.dir,
        outputDir: input.config.output.dir,
      });
      workspacePath = await ingester.clone(
        cleanSource,
        input.config.github.authMode,
        input.config.github.token
      );
      isTempWorkspace = true;
    } else if (isZip) {
      sourceKind = 'zip';
      const resolvedZip = path.resolve(cleanSource);
      if (!fs.existsSync(resolvedZip)) {
        throw new Error(`Zip archive does not exist: ${resolvedZip}`);
      }

      const stats = fs.statSync(resolvedZip);
      if (stats.size / (1024 * 1024 * 1024) > input.config.scan.maxRepoSizeGb) {
        throw new Error(`Zip archive size exceeds limit of ${input.config.scan.maxRepoSizeGb} GB.`);
      }

      workspacePath = path.join(tempClonesDir, `zip-${path.basename(cleanSource, '.zip')}-${Date.now()}`);
      fs.mkdirSync(workspacePath, { recursive: true });
      const zip = new AdmZip(resolvedZip);

      const resolvedTargetDir = path.resolve(workspacePath);
      for (const entry of zip.getEntries()) {
        const targetPath = path.resolve(resolvedTargetDir, entry.entryName);
        if (!targetPath.startsWith(resolvedTargetDir)) {
          throw new Error('Zip Slip security violation: entry escapes target directory');
        }
      }

      zip.extractAllTo(resolvedTargetDir, true);
      isTempWorkspace = true;
    } else {
      sourceKind = 'local';
      const resolvedLocal = path.resolve(cleanSource);
      if (!fs.existsSync(resolvedLocal) || !fs.statSync(resolvedLocal).isDirectory()) {
        throw new Error(`Local path does not exist or is not a directory: ${resolvedLocal}`);
      }

      workspacePath = path.join(tempClonesDir, `local-${path.basename(resolvedLocal)}-${Date.now()}`);
      const ignoreFilter = buildIgnoreFilter(resolvedLocal, input.config);
      copyDirSync(resolvedLocal, workspacePath, ignoreFilter);
      isTempWorkspace = true;
    }

    timings['acquisition'] = (Date.now() - startAcq) / 1000;

    try {
      const startDisc = Date.now();
      const meta = performDiscovery(workspacePath, input.config);
      meta.source = sourceKind;
      meta.name = path.basename(input.source.replace(/\.git$/, '').replace(/\/$/, ''));
      timings['discovery'] = (Date.now() - startDisc) / 1000;

      const startParse = Date.now();
      const ignoreFilter = buildIgnoreFilter(workspacePath, input.config);
      const sourceFiles: string[] = [];

      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (ignoreFilter(full)) continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) {
              sourceFiles.push(full);
            }
          }
        }
      };
      walk(workspacePath);

      for (const file of sourceFiles) {
        try {
          await parseFile(file, input.cache);
        } catch {}
      }
      timings['parsing'] = (Date.now() - startParse) / 1000;

      const startAnal = Date.now();
      const scanContext: ScanContext = {
        workspacePath,
        repoMeta: meta,
        config: input.config,
        cache: input.cache,
        logger: input.logger,
        mode: input.mode,
        offline: input.offline === true,
      };

      const runAllModules = input.mode !== 'quick';

      const securityAnalyzer = new XRaySecurityAnalyzer();
      const archAnalyzer = new XRayArchitectureAnalyzer();

      const [secFindings, archFindings] = await Promise.all([
        securityAnalyzer.scan(scanContext),
        runAllModules ? archAnalyzer.scan(scanContext) : Promise.resolve([] as Finding[]),
      ]);

      let depFindings: Finding[] = [];
      let testFindings: Finding[] = [];
      let maintFindings: Finding[] = [];
      let perfFindings: Finding[] = [];
      let gitFindings: Finding[] = [];
      let styleFindings: Finding[] = [];
      let dependencyScore = 100;
      let testCoverageScore = 100;
      let releaseScore = 100;
      let maintainabilityScore = 100;
      const extraReports: Record<string, string> = {};

      if (runAllModules) {
        const ciAnalyzer = new XRayCiAnalyzer();
        const depAnalyzer = new XRayDependencyAnalyzer();
        const testAnalyzer = new XRayTestingAnalyzer();
        const releaseAnalyzer = new XRayReleaseAnalyzer();
        const maintAnalyzer = new XRayMaintainabilityAnalyzer();
        const perfAnalyzer = new XRayPerformanceAnalyzer();
        const gitAnalyzer = new XRayGitAnalyzer();
        const styleAnalyzer = new XRayCodeStyleAnalyzer();
        const businessAnalyzer = new XRayBusinessAnalyzer();

        const depContext: ScanContext = { ...scanContext, priorFindings: secFindings };
        const ciResult = ciAnalyzer.analyze(scanContext);
        const [depResult, testResult] = await Promise.all([
          depAnalyzer.analyze(depContext),
          Promise.resolve(testAnalyzer.analyze(scanContext)),
        ]);

        const maintResult = maintAnalyzer.analyze(scanContext);
        const perfResult = perfAnalyzer.analyze(scanContext);
        const gitResult = gitAnalyzer.analyze(scanContext);
        const styleResult = styleAnalyzer.analyze(scanContext);
        const businessResult = businessAnalyzer.analyze(scanContext);
        const releaseResult = releaseAnalyzer.analyze(scanContext, ciResult.testsConfigured);

        depFindings = [...depResult.findings, ...ciResult.findings];
        testFindings = testResult.findings;
        maintFindings = maintResult.findings;
        perfFindings = perfResult.findings;
        gitFindings = [...gitResult.findings, ...businessResult.findings];
        styleFindings = styleResult.findings;
        dependencyScore = depResult.score;
        releaseScore = releaseResult.score;
        testCoverageScore = testResult.coveragePercent ?? 100;
        maintainabilityScore = Math.round((maintResult.score + perfResult.score + styleResult.score) / 3);

        extraReports['DEPENDENCY.md'] = depResult.report;
        extraReports['TEST_PLAN.md'] = testResult.report;
        extraReports['CI_REPORT.md'] = ciResult.report;
        extraReports['RELEASE.md'] = releaseResult.report;
        extraReports['RELEASE_CHECKLIST.md'] = releaseResult.checklist;
        extraReports['MAINTAINABILITY.md'] = maintResult.report;
        extraReports['PERFORMANCE.md'] = perfResult.report;
        extraReports['GIT.md'] = gitResult.report;
        extraReports['CODE_STYLE.md'] = styleResult.report;
        extraReports['BUSINESS.md'] = businessResult.report;
      }

      const allFindings = [...secFindings, ...archFindings, ...depFindings, ...testFindings, ...maintFindings, ...perfFindings, ...gitFindings, ...styleFindings];
      timings['analysis'] = (Date.now() - startAnal) / 1000;

      const startScore = Date.now();
      let securityScore = 100;
      for (const f of secFindings) {
        if (f.severity === 'CRITICAL') securityScore -= 25;
        else if (f.severity === 'HIGH') securityScore -= 15;
        else if (f.severity === 'MEDIUM') securityScore -= 5;
        else if (f.severity === 'LOW') securityScore -= 2;
      }
      securityScore = Math.max(0, Math.min(100, securityScore));

      let archScore = 100;
      const cycles = archFindings.filter((f: Finding) => f.title === 'Circular Dependency Detected');
      const godFiles = archFindings.filter((f: Finding) => f.title === 'God File (Anti-Pattern)');
      const violations = archFindings.filter((f: Finding) => f.title === 'Layering Violation');

      archScore -= cycles.length * 10;
      archScore -= godFiles.length * 5;
      archScore -= violations.length * 8;
      archScore = Math.max(0, Math.min(100, archScore));

      const overallInputs = runAllModules
        ? [securityScore, archScore, dependencyScore, testCoverageScore, releaseScore, maintainabilityScore]
        : [securityScore];

      const scores: ScoreCard = {
        overall: Math.round(overallInputs.reduce((a, b) => a + b, 0) / overallInputs.length),
        security: securityScore,
        architecture: archScore,
        maintainability: maintainabilityScore,
        testCoverage: testCoverageScore,
        releaseReadiness: releaseScore,
        dependency: dependencyScore,
      };
      timings['scoring'] = (Date.now() - startScore) / 1000;

      const validatedFindings = allFindings
        .map(validateFinding)
        .filter((f): f is Finding => f !== null);

      meta.languages = meta.languages || {};
      meta.frameworks = meta.frameworks || [];
      meta.packageManagers = meta.packageManagers || [];
      meta.entrypoints = detectEntrypoints(workspacePath, sourceFiles);
      meta.architectureStyle = detectArchitectureStyle(workspacePath, sourceFiles);

      const overallTime = (Date.now() - startOverall) / 1000;
      meta.runtime = {
        startedAt: meta.runtime?.startedAt || startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(overallTime * 1000),
      };

      const cleanSource = input.source.trim();
      const isGit = cleanSource.startsWith('https://github.com/') || cleanSource.startsWith('git@github.com:') || cleanSource.includes('github.com');
      const normalizedRepoSource = isGit ? cleanSource : path.resolve(cleanSource).replace(/\\/g, '/');
      const repoId = createHash('sha256').update(normalizedRepoSource).digest('hex').slice(0, 16);

      const fileHashes: string[] = [];
      const sortedRelativePaths = sourceFiles
        .map(f => path.relative(workspacePath, f).replace(/\\/g, '/'))
        .sort((a, b) => a.localeCompare(b));

      for (const relPath of sortedRelativePaths) {
        const fullPath = path.join(workspacePath, relPath);
        try {
          const content = fs.readFileSync(fullPath);
          const hash = createHash('sha256').update(content.toString('binary')).digest('hex');
          fileHashes.push(`${relPath}:${hash}`);
        } catch {}
      }

      const scanId = createHash('sha256').update(
        [repoId, input.mode, ...fileHashes].join('|')
      ).digest('hex').slice(0, 16);

      const result: ScanResult = {
        schema: '1.0',
        scanId,
        repoId,
        mode: input.mode,
        findings: validatedFindings,
        scores,
        meta,
      };

      if (runAllModules) {
        const promptBundle = new XRayPromptGenerator().generate(workspacePath, result);
        for (const [name, content] of Object.entries(promptBundle.files)) {
          extraReports[name] = content;
        }
        extraReports['VULN_REPORT.md'] = generateVulnReport(result).report;
        extraReports['ADOPTION.md'] = generateAdoptionReport(workspacePath, result).report;
        extraReports['FIXES.md'] = generateAutofixReport(result).report;
        extraReports['DASHBOARD.html'] = renderDashboard(result);
      }

      input.logger.info(`[pipeline] Stage timings:
  acquisition:  ${timings['acquisition'].toFixed(1)}s
  discovery:    ${timings['discovery'].toFixed(1)}s
  parsing:      ${timings['parsing'].toFixed(1)}s
  analysis:     ${timings['analysis'].toFixed(1)}s  (parallel)
  scoring:      ${timings['scoring'].toFixed(1)}s
  total:        ${overallTime.toFixed(1)}s`);

      const exporter = new XRayExportTarget();

      await exporter.render(result, {
        format: 'markdown',
        outputPath: input.config.output.dir,
        extraReports,
      });

      await exporter.render(result, {
        format: 'json',
        outputPath: input.config.output.dir,
      });

      await exporter.render(result, {
        format: 'html',
        outputPath: input.config.output.dir,
      });

      await exporter.render(result, {
        format: 'sarif',
        outputPath: input.config.output.dir,
      });

      await exporter.render(result, {
        format: 'pdf',
        outputPath: input.config.output.dir,
      });

      return result;
    } finally {
      if (isTempWorkspace && workspacePath && fs.existsSync(workspacePath)) {
        try {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}
