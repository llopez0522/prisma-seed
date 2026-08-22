import { closeContext, createContext, guardProduction, type GlobalFlags } from './context.js';
import { rollbackSeeders, runSeeders } from '../core/runner.js';

/**
 * `refresh` — equivalente a `migrate:refresh` de Laravel.
 *
 * Revierte todos los seeders y los vuelve a ejecutar.
 *
 * Es la alternativa **quirurgica** a `fresh`: en vez de vaciar la base entera,
 * llama al `down()` de cada seeder y luego a su `main()`. Solo deshace lo que
 * los seeders declararon que habian hecho, asi que respeta cualquier otro dato.
 * A cambio depende de que los `down()` esten bien escritos; `fresh` no depende
 * de nada.
 *
 * No tiene `--seed` a diferencia de Laravel: alli las migraciones y los seeders
 * son cosas distintas, y aqui los seeders son lo unico que hay. Volver a
 * ejecutarlos ES el comando.
 */

export interface RefreshCommandOptions extends GlobalFlags {
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export async function refreshCommand(options: RefreshCommandOptions): Promise<void> {
  guardProduction(options.force, 'refresh');

  const ctx = await createContext(options);

  try {
    if (!(await ctx.ledger.tableExists())) {
      ctx.logger.warn(
        `La tabla "${ctx.config.ledgerTable}" no existe: no hay nada que revertir, solo se sembrara.`
      );
    }
    await ctx.ledger.ensureTable();

    const revertidos = await rollbackSeeders(ctx, { all: true, dryRun: options.dryRun });
    if (!revertidos.dryRun && revertidos.reverted.length > 0) {
      ctx.logger.success(`${revertidos.reverted.length} seeders revertidos.`);
    }
    if (revertidos.skipped.length > 0) {
      ctx.logger.warn(`${revertidos.skipped.length} no se pudieron revertir. Revisa los avisos.`);
    }

    const aplicados = await runSeeders(ctx, { dryRun: options.dryRun });
    if (!aplicados.dryRun && aplicados.executed.length > 0) {
      ctx.logger.success(
        `${aplicados.executed.length} seeders ejecutados (batch ${String(aplicados.batch)}).`
      );
    }
  } finally {
    await closeContext(ctx);
  }
}
