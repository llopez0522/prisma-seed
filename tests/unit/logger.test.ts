import { describe, expect, it } from 'vitest';

import { createLogger, levelFromFlags, silentLogger } from '../../src/core/logger.js';

function capture(level?: Parameters<typeof levelFromFlags> extends never ? never : string) {
  const out: string[] = [];
  const err: string[] = [];
  const logger = createLogger({
    ...(level ? { level: level as 'info' } : {}),
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });
  return { logger, out, err };
}

describe('ConsoleLogger', () => {
  it('en nivel info emite info y success, pero no debug', () => {
    const { logger, out } = capture('info');

    logger.debug('detalle');
    logger.info('informacion');
    logger.success('hecho');

    expect(out).toHaveLength(2);
    expect(out.join('\n')).toContain('informacion');
    expect(out.join('\n')).toContain('hecho');
    expect(out.join('\n')).not.toContain('detalle');
  });

  it('en nivel debug emite todo', () => {
    const { logger, out } = capture('debug');

    logger.debug('detalle');
    logger.info('informacion');

    expect(out).toHaveLength(2);
  });

  it('manda avisos y errores a la salida de error, no a stdout', () => {
    const { logger, out, err } = capture('info');

    logger.warn('cuidado');
    logger.error('fallo');

    expect(out).toHaveLength(0);
    expect(err).toHaveLength(2);
  });

  it('en nivel error silencia info y warn', () => {
    const { logger, out, err } = capture('error');

    logger.info('informacion');
    logger.warn('cuidado');
    logger.error('fallo');

    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('fallo');
  });

  it('en nivel silent no emite nada', () => {
    const { logger, out, err } = capture('silent');

    logger.info('a');
    logger.warn('b');
    logger.error('c');
    logger.success('d');

    expect(out).toHaveLength(0);
    expect(err).toHaveLength(0);
  });
});

describe('levelFromFlags', () => {
  it('traduce los flags globales al nivel correspondiente', () => {
    expect(levelFromFlags({})).toBe('info');
    expect(levelFromFlags({ verbose: true })).toBe('debug');
    expect(levelFromFlags({ quiet: true })).toBe('error');
  });

  it('quiet gana a verbose si se pasan los dos', () => {
    expect(levelFromFlags({ quiet: true, verbose: true })).toBe('error');
  });
});

describe('silentLogger', () => {
  it('acepta todas las llamadas sin hacer nada', () => {
    expect(() => {
      silentLogger.debug('a');
      silentLogger.info('b');
      silentLogger.warn('c');
      silentLogger.error('d');
      silentLogger.success('e');
    }).not.toThrow();
  });
});
