/** Minimal structured logger. Headless runs stay greppable; TTY runs stay readable. */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'step';

const ESC = String.fromCharCode(27);

const COLORS: Record<Level, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
  step: `${ESC}[35m`,
};
const RESET = `${ESC}[0m`;

const QUIET = process.env.CF_QUIET === '1';
const DEBUG = process.env.CF_DEBUG === '1';
const useColor = Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined;

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (QUIET && level !== 'error') return;
  if (level === 'debug' && !DEBUG) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
  const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  // Always stderr: stdout is reserved for machine-readable payloads in headless mode.
  process.stderr.write(`${stamp} ${head} ${message}${tail}\n`);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
  step: (m: string, meta?: Record<string, unknown>) => emit('step', `>> ${m}`, meta),
};

/** stdout is the payload channel — headless `claude -p` consumers parse it. */
export function emitPayload(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
