import { closeContext, createContext, guardProduction, type GlobalFlags } from './context.js';
import { UsageError } from '../core/errors.js';
import { rollbackSeeders } from '../core/runner.js';

/**
 * `rollback [nombre]` — equivalente a `migrate:rollback` de Laravel.
 *
 * **Cambio de comportamiento respecto de la v0.2.4**: sin argumentos revierte solo
 * el ultimo batch, no todo el historico. Para el comportamiento anterior esta
 * `--all`. Es la razon principal del salto a v1.0.0.
 */

export interface RollbackCommandOptions extends GlobalFlags {
  step?: string | undefined;
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
}

function parseStep(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`--step debe ser un entero positivo, se recibio "${raw}".`);
  }
  return n;
}

export async function rollbackCommand(
  nombre: string | undefined,
  options: RollbackCommandOptions
): Promise<void> {
  guardProduction(options.force, 'rollback');

  const step = parseStep(options.step);
  const exclusivas = [nombre !== undefined, step !== undefined, options.all === true].filter(
    Boolean
  ).length;

  if (exclusivas > 1) {
    throw new UsageError(
      'Un seeder concreto, --step y --all son mutuamente excluyentes.',
      'Elige uno solo.'
    );
  }

  const ctx = await createContext(options);

  try {
    if (!(await ctx.ledger.tableExists())) {
      ctx.logger.warn(
        `La tabla "${ctx.config.ledgerTable}" no existe, asi que no hay nada registrado que revertir.`
      );
      return;
    }
    await ctx.ledger.ensureTable();

    const report = await rollbackSeeders(ctx, {
      only: nombre,
      step,
      all: options.all,
      dryRun: options.dryRun,
    });

    if (report.dryRun) return;

    if (report.reverted.length > 0) {
      ctx.logger.success(`${report.reverted.length} seeders revertidos.`);
    }
    if (report.skipped.length > 0) {
      ctx.logger.warn(`${report.skipped.length} omitidos. Revisa los avisos de arriba.`);
    }
  } finally {
    await closeContext(ctx);
  }
}
