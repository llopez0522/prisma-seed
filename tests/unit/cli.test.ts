import { describe, expect, it } from 'vitest';

import { buildProgram, reportError } from '../../src/cli.js';
import { CliError, EXIT, UsageError } from '../../src/core/errors.js';
import { defineConfig } from '../../src/index.js';

describe('andamiaje del CLI', () => {
  it('declara toda la superficie de comandos prevista', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();

    expect(names).toEqual(['fresh', 'generate', 'refresh', 'rollback', 'run', 'status']);
  });

  it('expone --help y --version sin ejecutar ningun comando', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('prisma-seed');
    // La version la inyecta tsup; en test corre via ts, asi que solo se comprueba
    // que la opcion este registrada.
    expect(program.options.some((o) => o.long === '--version')).toBe(true);
  });

  it('registra en run los flags de paridad con Laravel', () => {
    const run = buildProgram().commands.find((c) => c.name() === 'run');
    const longs = run?.options.map((o) => o.long) ?? [];

    expect(longs).toEqual(expect.arrayContaining(['--class', '--step', '--dry-run', '--force']));
  });

  it('registra fresh --seed, el equivalente a migrate:fresh --seed', () => {
    const fresh = buildProgram().commands.find((c) => c.name() === 'fresh');
    expect(fresh?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--seed', '--force'])
    );
  });

  it('registra en rollback los flags de paridad con Laravel', () => {
    const rollback = buildProgram().commands.find((c) => c.name() === 'rollback');
    const longs = rollback?.options.map((o) => o.long) ?? [];

    expect(longs).toEqual(expect.arrayContaining(['--step', '--all', '--dry-run', '--force']));
  });

  it('expone los flags globales', () => {
    const longs = buildProgram().options.map((o) => o.long);

    expect(longs).toEqual(
      expect.arrayContaining(['--quiet', '--verbose', '--cwd', '--no-transaction'])
    );
  });
});

describe('reportError', () => {
  it('respeta el codigo de salida del CliError', () => {
    const salida: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => salida.push(String(msg));

    try {
      expect(reportError(new UsageError('mal uso', 'prueba esto'))).toBe(EXIT.USAGE);
      expect(reportError(new CliError('fallo', EXIT.CONNECTION))).toBe(EXIT.CONNECTION);
      expect(reportError(new Error('generico'))).toBe(EXIT.FAILURE);
    } finally {
      console.error = original;
    }

    expect(salida.join('\n')).toContain('mal uso');
    expect(salida.join('\n')).toContain('prueba esto');
  });
});

describe('defineConfig', () => {
  it('devuelve la configuracion sin alterarla', () => {
    const config = { seedersDir: 'prisma/seeders', transactional: false };
    expect(defineConfig(config)).toEqual(config);
  });
});
