import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger, LogLevel } from '../logger';

describe('Logger utility', () => {
  const originalEnv = { ...process.env };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let logSpy: any;
  let warnSpy: any;
  let errorSpy: any;
  let debugSpy: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    process.env = { ...originalEnv };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should emit structured JSON for info, warn, error at info threshold', () => {
    const log = createLogger('info');
    log.info('hello info', { key: 'val' });
    log.warn('hello warn');
    log.error('hello error');

    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello info');
    expect(parsed.key).toBe('val');
  });

  it('should suppress debug messages when threshold is info', () => {
    const log = createLogger('info');
    log.debug('should be suppressed');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('should emit debug when threshold is debug', () => {
    const log = createLogger('debug');
    log.debug('visible debug');
    expect(debugSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(debugSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('debug');
  });

  it('should emit only errors when threshold is error', () => {
    const log = createLogger('error');
    log.info('suppressed');
    log.warn('suppressed');
    log.debug('suppressed');
    log.error('visible error');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('should emit JSON in CI mode for all levels at or above threshold', () => {
    process.env.CI = 'true';
    // In CI mode, logger does NOT suppress — it uses the configured threshold only.
    const log = createLogger('info');
    log.info('ci info message');
    log.warn('ci warn message');
    log.error('ci error message');

    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('ci info message');
  });

  it('should read level from XRAY_LOG_LEVEL env when no argument supplied', () => {
    process.env.XRAY_LOG_LEVEL = 'warn';
    const log = createLogger();
    log.info('should be suppressed');
    log.warn('should be visible');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('should fall back to info level for unknown XRAY_LOG_LEVEL values', () => {
    process.env.XRAY_LOG_LEVEL = 'verbose' as LogLevel;
    const log = createLogger();
    log.info('visible');
    expect(logSpy).toHaveBeenCalledOnce();
  });
});
