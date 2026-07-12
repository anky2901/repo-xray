export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  time(label: string): () => void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(env?: string): LogLevel {
  const candidate = (env ?? '').toLowerCase();
  if (candidate in LEVEL_RANK) return candidate as LogLevel;
  return 'info';
}

export function createLogger(level?: LogLevel): Logger {
  const threshold = LEVEL_RANK[level ?? resolveLevel(process.env.XRAY_LOG_LEVEL)];

  function emit(logLevel: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_RANK[logLevel] < threshold) return;
    const line = JSON.stringify({ level: logLevel, msg, ...meta });
    if (logLevel === 'error') {
      console.error(line);
    } else if (logLevel === 'warn') {
      console.warn(line);
    } else if (logLevel === 'debug') {
      console.debug(line);
    } else {
      console.log(line);
    }
  }

  return {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    time: (label) => {
      const start = Date.now();
      return () => emit('debug', `${label} took ${Date.now() - start}ms`);
    },
  };
}

// Default singleton — level driven by XRAY_LOG_LEVEL env var, falls back to 'info'.
export const logger: Logger = createLogger();
