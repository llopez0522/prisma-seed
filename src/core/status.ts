import type { DiscoveredSeeder, SeedExecutionRecord } from '../types.js';

/**
 * Estado de cada seeder: lo que hay en disco cruzado con lo que dice el ledger.
 *
 * La logica va aparte del comando y sin efectos para poder probarla sin base de
 * datos. El comando solo la formatea.
 */

export type SeederState =
  /** En disco y registrado como ejecutado. */
  | 'applied'
  /** En disco y sin registrar. */
  | 'pending'
  /**
   * Registrado pero sin archivo.
   *
   * No es una anomalia que haya que limpiar: puede ser una rama sin mergear, o
   * un seeder borrado por error. Se muestra porque perder ese dato en silencio
   * es peor — sin el no hay forma de saber que llego a aplicarse.
   */
  | 'missing-file';

export interface SeederStatus {
  name: string;
  state: SeederState;
  /** Lote en el que se ejecuto, o `null` si esta pendiente. */
  batch: number | null;
  executedAt: Date | null;
}

export interface StatusSummary {
  rows: SeederStatus[];
  onDisk: number;
  applied: number;
  pending: number;
  missingFile: number;
}

/**
 * Cruza disco y ledger.
 *
 * Orden: primero los de disco, en su orden de ejecucion; despues los registrados
 * cuyo archivo no aparece, que son la excepcion y conviene ver al final.
 */
export function buildStatus(
  onDisk: readonly DiscoveredSeeder[],
  records: readonly SeedExecutionRecord[]
): StatusSummary {
  const porNombre = new Map(records.map((r) => [r.seedName, r] as const));
  const enDisco = new Set(onDisk.map((s) => s.name));

  const rows: SeederStatus[] = onDisk.map((seeder) => {
    const registro = porNombre.get(seeder.name);
    return registro
      ? {
          name: seeder.name,
          state: 'applied' as const,
          batch: registro.batch,
          executedAt: registro.executedAt,
        }
      : { name: seeder.name, state: 'pending' as const, batch: null, executedAt: null };
  });

  const huerfanos: SeederStatus[] = records
    .filter((r) => !enDisco.has(r.seedName))
    .sort((a, b) => (a.batch === b.batch ? a.id - b.id : a.batch - b.batch))
    .map((r) => ({
      name: r.seedName,
      state: 'missing-file' as const,
      batch: r.batch,
      executedAt: r.executedAt,
    }));

  const todas = [...rows, ...huerfanos];

  return {
    rows: todas,
    onDisk: onDisk.length,
    applied: todas.filter((r) => r.state === 'applied').length,
    pending: todas.filter((r) => r.state === 'pending').length,
    missingFile: huerfanos.length,
  };
}
