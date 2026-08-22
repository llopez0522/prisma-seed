import pc from 'picocolors';

import type { Logger } from '../types.js';

/**
 * Salida del CLI.
 *
 * La v0.2.4 llamaba a `console.log` con emojis incrustados por todo el codigo, sin
 * forma de silenciarlo ni de subir el detalle. Aqui la salida se centraliza para
 * poder ofrecer --quiet y --verbose, y para que los tests capturen sin parchear
 * console.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Destino de la salida. Inyectable para los tests. */
  write?: (line: string) => void;
  /** Destino de errores y avisos. */
  writeError?: (line: string) => void;
}

export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;
  private readonly writeError: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.writeError = options.writeError ?? ((line) => process.stderr.write(`${line}\n`));
  }

  private enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return ORDER[this.level] >= ORDER[level];
  }

  debug(msg: string): void {
    if (this.enabled('debug')) this.write(pc.dim(`  ${msg}`));
  }

  info(msg: string): void {
    if (this.enabled('info')) this.write(msg);
  }

  success(msg: string): void {
    if (this.enabled('info')) this.write(`${pc.green('✓')} ${msg}`);
  }

  warn(msg: string): void {
    if (this.enabled('warn')) this.writeError(`${pc.yellow('!')} ${msg}`);
  }

  error(msg: string): void {
    if (this.enabled('error')) this.writeError(`${pc.red('✗')} ${msg}`);
  }
}

/** Logger que no emite nada. Util en tests y en --quiet. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

export function createLogger(options: LoggerOptions = {}): Logger {
  return new ConsoleLogger(options);
}

/** Traduce los flags globales del CLI al nivel de log correspondiente. */
export function levelFromFlags(flags: {
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
}): LogLevel {
  if (flags.quiet === true) return 'error';
  if (flags.verbose === true) return 'debug';
  return 'info';
}
