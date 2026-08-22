import { closeContext, createContext, guardProduction, type GlobalFlags } from './context.js';
import { UsageError } from '../core/errors.js';
import { runSeeders } from '../core/runner.js';

/** `run [nombre]` — equivalente a `db:seed` de Laravel. */

export interface RunCommandOptions extends GlobalFlags {
  class?: string | undefined;
  step?: string | undefined;
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

export async function runCommand(
  nombre: string | undefined,
  options: RunCommandOptions
): Promise<void> {
  guardProduction(options.force, 'run');

  // `--class` es alias de argumento posicional, por familiaridad con Laravel.
  const only = nombre ?? options.class;
  const step = parseStep(options.step);

  if (only !== undefined && step !== undefined) {
    throw new UsageError(
      'No se pueden combinar un seeder concreto y --step.',
      'Usa uno u otro: "run User" o "run --step=3".'
    );
  }

  const ctx = await createContext(options);

  try {
    const { created, migrated } = await ctx.ledger.ensureTable();
    if (created) ctx.logger.info(`Tabla "${ctx.config.ledgerTable}" creada.`);
    if (migrated) {
      ctx.logger.info(
        `Tabla "${ctx.config.ledgerTable}" migrada: se anadio la columna "batch" (historico en batch 1).`
      );
    }

    const report = await runSeeders(ctx, {
      only,
      step,
      dryRun: options.dryRun,
    });

    if (report.dryRun) return;

    if (report.executed.length > 0) {
      ctx.logger.success(
        `${report.executed.length} seeders ejecutados (batch ${String(report.batch)}).`
      );
    }
  } finally {
    await closeContext(ctx);
  }
}
