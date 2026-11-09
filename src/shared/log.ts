// Logger tối giản: một dòng một sự kiện, có thời gian ISO, đủ cho pm2 logs.

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < order[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return JSON.stringify({ error: v.message, stack: v.stack?.split('\n').slice(0, 4).join(' | ') });
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export type Logger = ReturnType<typeof logger>;
