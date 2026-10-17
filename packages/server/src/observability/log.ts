import { trace } from '@opentelemetry/api';
import { errorMessage } from '@lms/protocol';

/**
 * Structured logging.
 *
 * One line per event, with the event's context as fields rather than spliced
 * into the message: `matchId`, `round`, `address`, `txHash`, `chainId`. A log
 * pipeline can then answer "everything that happened to match 0xab…" with a
 * field filter instead of a regex, and the `matchId` field doubles as the
 * correlation id across the gateway, the room, the bridge and the relayer.
 *
 * Deliberately small rather than a dependency: the format is the contract, and
 * the format is a JSON object per line. `LOG_FORMAT=pretty` prints the same
 * fields for a human at a terminal, which is the default outside production.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: Fields): Logger;
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  format?: 'json' | 'pretty';
  level?: Level;
  /**
   * Where a finished line goes. Defaults to the console method matching the
   * level, so warnings and errors reach stderr.
   */
  sink?: (level: Level, line: string) => void;
  now?: () => number;
}

export function createLogger(options: LoggerOptions = {}, bound: Fields = {}): Logger {
  const format = options.format ?? 'json';
  const threshold = RANK[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? Date.now;

  const write = (level: Level, message: string, fields: Fields = {}): void => {
    if (RANK[level] < threshold) return;
    const record: Fields = { ...bound, ...normalise(fields) };
    // Joins a log line to the trace it happened in, when tracing is on.
    const span = trace.getActiveSpan()?.spanContext();
    if (span && span.traceId !== INVALID_TRACE) {
      record.traceId = span.traceId;
      record.spanId = span.spanId;
    }
    sink(level, format === 'json' ? json(now(), level, message, record) : pretty(level, message, record));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

const INVALID_TRACE = '00000000000000000000000000000000';

/** Errors become their message, bigints their decimal string: both survive `JSON.stringify`. */
function normalise(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error ? errorMessage(value) : typeof value === 'bigint' ? value.toString() : value;
  }
  return out;
}

function json(time: number, level: Level, message: string, fields: Fields): string {
  return JSON.stringify({ time: new Date(time).toISOString(), level, msg: message, ...fields });
}

function pretty(level: Level, message: string, fields: Fields): string {
  const { component, ...rest } = fields;
  const tag = typeof component === 'string' ? `[${component}] ` : '';
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${level === 'info' ? '' : `${level.toUpperCase()} `}${tag}${message}${extra ? ` ${extra}` : ''}`;
}

function consoleSink(level: Level, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function envLevel(value: string | undefined): Level {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

/**
 * The process logger. Configured from the environment directly rather than
 * through `config`, because every module needs it at import time and
 * `config` would otherwise have to be imported by all of them.
 */
export const log = createLogger({
  format: process.env.LOG_FORMAT === 'json' || (process.env.LOG_FORMAT !== 'pretty' && process.env.NODE_ENV === 'production') ? 'json' : 'pretty',
  level: envLevel(process.env.LOG_LEVEL),
});
