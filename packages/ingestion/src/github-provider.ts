import simpleGit from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RateLimiter {
  private retries = 0;
  private remaining = 60;
  private resetAt = 0;
  private limitHitOccurred = false;
  private outputDir: string;

  constructor(outputDir: string = '.xray-reports') {
    this.outputDir = outputDir;
  }

  private isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    const msg = String((error as { message?: string })?.message || error).toLowerCase();
    return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429') || msg.includes('403');
  }

  private async writeRateLimitReport(error: unknown): Promise<void> {
    this.limitHitOccurred = true;
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      const reportPath = path.join(this.outputDir, 'RATE_LIMIT_REPORT.md');
      const content = `# Rate Limit Report

Rate limits were encountered during scanning.

- **Timestamp**: ${new Date().toISOString()}
- **Details**: ${(error as { message?: string })?.message || String(error)}
- **Backoff Attempt**: ${this.retries + 1}
- **Status**: Automatically retrying with exponential backoff...
`;
      await fs.promises.writeFile(reportPath, content, 'utf-8');
    } catch {}
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.remaining <= 5) {
      const wait = this.resetAt - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
    }

    try {
      const result = await fn();
      return result;
    } catch (e: unknown) {
      if (this.isRateLimitError(e)) {
        await this.writeRateLimitReport(e);
        const backoffMs = Math.pow(2, this.retries++) * 1000;
        await sleep(backoffMs);
        return this.execute(fn);
      }
      throw e;
    }
  }
}

export function getDirectorySize(dirPath: string): number {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const stats = fs.statSync(dirPath);
  if (stats.isFile()) return stats.size;
  if (stats.isDirectory()) {
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        size += getDirectorySize(path.join(dirPath, file));
      }
    } catch {}
  }
  return size;
}

export class GitHubIngester {
  private rateLimiter: RateLimiter;
  private maxRepoSizeGb: number;
  private cacheDir: string;

  constructor(options: { maxRepoSizeGb: number; cacheDir: string; outputDir: string }) {
    this.rateLimiter = new RateLimiter(options.outputDir);
    this.maxRepoSizeGb = options.maxRepoSizeGb;
    this.cacheDir = options.cacheDir;
  }

  isGitHubUrl(url: string): boolean {
    return url.startsWith('https://github.com/') || url.startsWith('git@github.com:') || url.includes('github.com');
  }

  parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    const clean = url.replace(/\.git$/, '').trim();
    let parts: string[] = [];
    if (clean.startsWith('git@github.com:')) {
      parts = clean.slice('git@github.com:'.length).split('/');
    } else {
      try {
        const parsed = new URL(clean);
        parts = parsed.pathname.slice(1).split('/');
      } catch {
        const match = clean.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (match) {
          return { owner: match[1], repo: match[2] };
        }
      }
    }
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  }

  async clone(url: string, authMode: 'public' | 'pat' | 'ssh', token?: string): Promise<string> {
    const parsed = this.parseGitHubUrl(url);
    if (!parsed) {
      throw new Error(`Invalid GitHub URL format: ${url}`);
    }

    const tempClonesDir = path.join(this.cacheDir, 'temp-clones');
    if (!fs.existsSync(tempClonesDir)) {
      fs.mkdirSync(tempClonesDir, { recursive: true });
    }

    const targetDir = path.join(tempClonesDir, `${parsed.owner}-${parsed.repo}-${Date.now()}`);
    let cloneUrl = url;

    if (authMode === 'pat' && token) {
      cloneUrl = `https://${token}@github.com/${parsed.owner}/${parsed.repo}.git`;
    } else if (authMode === 'ssh') {
      cloneUrl = `git@github.com:${parsed.owner}/${parsed.repo}.git`;
    } else {
      cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    }

    const git = simpleGit();

    try {
      await this.rateLimiter.execute(async () => {
        await git.clone(cloneUrl, targetDir, ['--depth', '1']);
      });
    } catch (err: unknown) {
      const error = err as Error;
      let msg = error.message;
      if (token) {
        msg = msg.replace(new RegExp(token, 'g'), '[REDACTED_TOKEN]');
      }
      throw new Error(`Failed to clone repository: ${msg}`);
    }

    const totalSizeBytes = getDirectorySize(targetDir);
    const totalSizeGb = totalSizeBytes / (1024 * 1024 * 1024);

    if (totalSizeGb > this.maxRepoSizeGb) {
      try {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
      } catch {}
      throw new Error(`Repository size limit exceeded. Max: ${this.maxRepoSizeGb} GB, Actual: ${totalSizeGb.toFixed(3)} GB.`);
    }

    return targetDir;
  }
}
