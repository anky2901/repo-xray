import { z } from 'zod';

import * as fs from 'fs';
import * as path from 'path';

export const xrayConfigSchema = z.object({
  telemetry: z.literal(false).default(false),
  ai: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai', 'anthropic', 'ollama']).nullable().default(null),
    apiKey: z.string().optional(),
    model: z.string().optional()
  }).default({ enabled: false, provider: null }),
  github: z.object({
    token: z.string().optional(),
    authMode: z.enum(['pat', 'ssh', 'public']).default('public')
  }).default({ authMode: 'public' }),
  scan: z.object({
    maxMemoryMb: z.number().default(512),
    timeoutMs: z.number().default(60000),
    maxRepoSizeGb: z.number().default(2),
    parallel: z.boolean().default(true)
  }).default({ maxMemoryMb: 512, timeoutMs: 60000, maxRepoSizeGb: 2, parallel: true }),
  ignore: z.object({
    useGitignore: z.boolean().default(true),
    patterns: z.array(z.string()).default([])
  }).default({ useGitignore: true, patterns: [] }),
  cache: z.object({
    enabled: z.boolean().default(true),
    dir: z.string().default('.xray-cache'),
    ttlHours: z.number().default(24)
  }).default({ enabled: true, dir: '.xray-cache', ttlHours: 24 }),
  output: z.object({
    dir: z.string().default('.xray-reports'),
    formats: z.array(z.enum(['markdown', 'html', 'json', 'pdf', 'sarif'])).default(['json'])
  }).default({ dir: '.xray-reports', formats: ['json'] })
});

export type XRayConfig = z.infer<typeof xrayConfigSchema>;

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val === undefined) continue;
    if (isObject(result[key]) && isObject(val)) {
      result[key] = mergeConfig(result[key] as Record<string, unknown>, val);
    } else if (Array.isArray(val)) {
      result[key] = [...val];
    } else if (isObject(val)) {
      result[key] = mergeConfig({}, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function loadXrayrc(): Record<string, unknown> {
  const rootDir = process.cwd();
  const paths = [
    path.join(rootDir, '.xrayrc'),
    path.join(rootDir, '.xrayrc.json')
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch (err: unknown) {
        const error = err as Error;
        throw new Error(`Failed to parse config file ${p}: ${error.message}`);
      }
    }
  }
  return {};
}

function loadEnvConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  
  if (env.XRAY_TELEMETRY !== undefined) {
    config.telemetry = env.XRAY_TELEMETRY === 'true';
  }
  
  if (env.XRAY_AI_ENABLED !== undefined) {
    const ai = (config.ai || {}) as Record<string, unknown>;
    ai.enabled = env.XRAY_AI_ENABLED === 'true';
    config.ai = ai;
  }
  if (env.XRAY_AI_PROVIDER !== undefined) {
    const ai = (config.ai || {}) as Record<string, unknown>;
    ai.provider = env.XRAY_AI_PROVIDER;
    config.ai = ai;
  }
  if (env.XRAY_AI_API_KEY !== undefined) {
    const ai = (config.ai || {}) as Record<string, unknown>;
    ai.apiKey = env.XRAY_AI_API_KEY;
    config.ai = ai;
  }
  if (env.XRAY_AI_MODEL !== undefined) {
    const ai = (config.ai || {}) as Record<string, unknown>;
    ai.model = env.XRAY_AI_MODEL;
    config.ai = ai;
  }
  
  if (env.XRAY_GITHUB_TOKEN !== undefined) {
    const github = (config.github || {}) as Record<string, unknown>;
    github.token = env.XRAY_GITHUB_TOKEN;
    config.github = github;
  }
  if (env.XRAY_GITHUB_AUTH_MODE !== undefined) {
    const github = (config.github || {}) as Record<string, unknown>;
    github.authMode = env.XRAY_GITHUB_AUTH_MODE;
    config.github = github;
  }
  
  if (env.XRAY_SCAN_MAX_MEMORY_MB !== undefined) {
    const scan = (config.scan || {}) as Record<string, unknown>;
    scan.maxMemoryMb = parseInt(env.XRAY_SCAN_MAX_MEMORY_MB, 10);
    config.scan = scan;
  }
  if (env.XRAY_SCAN_TIMEOUT_MS !== undefined) {
    const scan = (config.scan || {}) as Record<string, unknown>;
    scan.timeoutMs = parseInt(env.XRAY_SCAN_TIMEOUT_MS, 10);
    config.scan = scan;
  }
  if (env.XRAY_SCAN_MAX_REPO_SIZE_GB !== undefined) {
    const scan = (config.scan || {}) as Record<string, unknown>;
    scan.maxRepoSizeGb = parseInt(env.XRAY_SCAN_MAX_REPO_SIZE_GB, 10);
    config.scan = scan;
  }
  if (env.XRAY_SCAN_PARALLEL !== undefined) {
    const scan = (config.scan || {}) as Record<string, unknown>;
    scan.parallel = env.XRAY_SCAN_PARALLEL === 'true';
    config.scan = scan;
  }
  
  if (env.XRAY_IGNORE_USE_GITIGNORE !== undefined) {
    const ignore = (config.ignore || {}) as Record<string, unknown>;
    ignore.useGitignore = env.XRAY_IGNORE_USE_GITIGNORE === 'true';
    config.ignore = ignore;
  }
  if (env.XRAY_IGNORE_PATTERNS !== undefined) {
    const ignore = (config.ignore || {}) as Record<string, unknown>;
    ignore.patterns = env.XRAY_IGNORE_PATTERNS.split(',').map(s => s.trim());
    config.ignore = ignore;
  }
  
  if (env.XRAY_CACHE_ENABLED !== undefined) {
    const cache = (config.cache || {}) as Record<string, unknown>;
    cache.enabled = env.XRAY_CACHE_ENABLED === 'true';
    config.cache = cache;
  }
  if (env.XRAY_CACHE_DIR !== undefined) {
    const cache = (config.cache || {}) as Record<string, unknown>;
    cache.dir = env.XRAY_CACHE_DIR;
    config.cache = cache;
  }
  if (env.XRAY_CACHE_TTL_HOURS !== undefined) {
    const cache = (config.cache || {}) as Record<string, unknown>;
    cache.ttlHours = parseInt(env.XRAY_CACHE_TTL_HOURS, 10);
    config.cache = cache;
  }
  
  if (env.XRAY_OUTPUT_DIR !== undefined) {
    const output = (config.output || {}) as Record<string, unknown>;
    output.dir = env.XRAY_OUTPUT_DIR;
    config.output = output;
  }
  if (env.XRAY_OUTPUT_FORMATS !== undefined) {
    const output = (config.output || {}) as Record<string, unknown>;
    output.formats = env.XRAY_OUTPUT_FORMATS.split(',').map(s => s.trim());
    config.output = output;
  }
  
  return config;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, cliOverrides: Partial<XRayConfig> = {}): XRayConfig {
  const defaults = xrayConfigSchema.parse({});
  const fileConfig = loadXrayrc();
  const envConfig = loadEnvConfig(env);
  
  const step1 = mergeConfig(defaults as unknown as Record<string, unknown>, fileConfig);
  const step2 = mergeConfig(step1, envConfig);
  const finalMerged = mergeConfig(step2, cliOverrides as Record<string, unknown>);
  
  const parsed = xrayConfigSchema.safeParse(finalMerged);
  if (!parsed.success) {
    throw new Error(`Config validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}
