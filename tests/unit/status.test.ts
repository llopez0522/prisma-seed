import { describe, expect, it } from 'vitest';

import { formatear } from '../../src/commands/status.js';
import { buildStatus } from '../../src/core/status.js';
import type { DiscoveredSeeder, SeedExecutionRecord } from '../../src/types.js';

function enDisco(...nombres: string[]): DiscoveredSeeder[] {
  return nombres.map((name) => ({
    name,
    absolutePath: `/p/prisma/seeders/${name}.js`,
    timestamp: /^(\d{14})_/.exec(name)?.[1] ?? null,
  }));
}

function registro(seedName: string, batch: number, id = 1): SeedExecutionRecord {
  return { id, seedName, batch, executedAt: new Date('2026-01-01T00:00:00Z') };
}

describe('buildStatus', () => {
  it('marca como ejecutado lo que esta en el ledger, con su lote', () => {
    const { rows } = buildStatus(enDisco('20240101000001_User'), [
      registro('20240101000001_User', 3),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({ name: '20240101000001_User', state: 'applied', batch: 3 }),
    ]);
  });

  it('marca como pendiente lo que esta en disco y no en el ledger', () => {
    const { rows } = buildStatus(enDisco('20240101000001_User'), []);

    expect(rows[0]).toEqual(
      expect.objectContaining({ state: 'pending', batch: null, executedAt: null })
    );
  });

  /**
   * El caso que no se puede tragar en silencio: hay constancia de que se aplico
   * pero el archivo ya no esta. Sin mostrarlo no hay forma de enterarse.
   */
  it('senala lo registrado cuyo archivo ya no existe', () => {
    const { rows, missingFile } = buildStatus(enDisco('20240101000002_Post'), [
      registro('20240101000001_Borrado', 1),
    ]);

    expect(missingFile).toBe(1);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['20240101000002_Post', 'pending'],
      ['20240101000001_Borrado', 'missing-file'],
    ]);
  });

  it('respeta el orden de disco y deja los huerfanos al final', () => {
    const { rows } = buildStatus(enDisco('20240101000001_A', '20240101000002_B'), [
      registro('20230101000000_Viejo', 1, 5),
      registro('20240101000001_A', 2, 6),
    ]);

    expect(rows.map((r) => r.name)).toEqual([
      '20240101000001_A',
      '20240101000002_B',
      '20230101000000_Viejo',
    ]);
  });

  it('cuenta bien el resumen', () => {
    const resumen = buildStatus(enDisco('A', 'B', 'C'), [registro('A', 1), registro('Z', 1, 9)]);

    expect(resumen).toMatchObject({ onDisk: 3, applied: 1, pending: 2, missingFile: 1 });
  });

  it('tolera una base sin nada ejecutado y un directorio vacio', () => {
    expect(buildStatus([], [])).toMatchObject({ rows: [], onDisk: 0, applied: 0, pending: 0 });
  });
});

describe('formatear', () => {
  it('alinea las columnas y cierra con el resumen', () => {
    const salida = formatear(
      buildStatus(enDisco('20240101000001_User', '20240101000002_Post'), [
        registro('20240101000001_User', 1),
      ])
    );

    expect(salida[0]).toContain('20240101000001_User');
    expect(salida[0]).toContain('ejecutado');
    expect(salida[1]).toContain('pendiente');
    expect(salida.at(-1)).toBe('2 en disco · 1 ejecutados · 1 pendientes');
  });

  it('solo menciona los huerfanos cuando los hay', () => {
    const sin = formatear(buildStatus(enDisco('A'), []));
    expect(sin.at(-1)).not.toContain('sin archivo');

    const con = formatear(buildStatus(enDisco('A'), [registro('Z', 1)]));
    expect(con.at(-1)).toContain('1 sin archivo');
  });
});
