import { confirm } from '@inquirer/prompts';

import { closeContext, createContext, guardProduction, type GlobalFlags } from './context.js';
import { CliError, EXIT } from '../core/errors.js';
import { runSeeders } from '../core/runner.js';
import { listUserTables } from '../core/tables.js';

/**
 * `fresh [--seed]` — equivalente a `migrate:fresh` de Laravel.
 *
 * Vacia **todas** las tablas de la base y resetea los autoincrementales, de modo
 * que la siguiente siembra parte de ids 1. Con `--seed`, siembra a continuacion.
 *
 * Dos decisiones que conviene entender:
 *
 *  - **Vacia, no borra ni recrea el esquema.** Laravel puede permitirse un
 *    `drop` porque es dueño de las migraciones; aqui las tiene Prisma o el ORM
 *    que sea, y recrearlas exigiria invocar su CLI — acoplando la libreria a una
 *    implementacion concreta, que es justo lo que no se hace en ningun otro
 *    sitio. `TRUNCATE ... RESTART IDENTITY` deja el mismo resultado observable
 *    sin tocar el esquema.
 *  - **El registro de migraciones se respeta.** `_prisma_migrations` y demas
 *    tablas con prefijo `_` quedan fuera (ver `core/tables.ts`). Vaciarlas haria
 *    creer al ORM que no se ha migrado nada.
 *
 * Es la operacion mas destructiva de la libreria: pide confirmacion salvo
 * `--force`, y si no hay terminal interactiva se niega en vez de asumir que si.
 */

export interface FreshCommandOptions extends GlobalFlags {
  seed?: boolean | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export async function freshCommand(options: FreshCommandOptions): Promise<void> {
  guardProduction(options.force, 'fresh');

  const ctx = await createContext(options);

  try {
    const tablas = await listUserTables(ctx.client, ctx.dialect, {
      exclude: ctx.config.freshExclude,
    });

    if (tablas.length === 0) {
      ctx.logger.warn('No hay ninguna tabla que vaciar.');
      return;
    }

    if (options.dryRun === true) {
      ctx.logger.info(`Se vaciarian ${String(tablas.length)} tablas:`);
      for (const t of tablas) ctx.logger.info(`  - ${t}`);
      if (options.seed === true) ctx.logger.info('Y despues se ejecutarian los seeders.');
      return;
    }

    if (options.force !== true) {
      await confirmarDestruccion(tablas);
    }

    for (const sentencia of ctx.dialect.truncateAll(tablas)) {
      try {
        await ctx.client.$executeRawUnsafe(sentencia.sql);
      } catch (error) {
        // Solo se perdona lo que el dialecto declaro de mejor esfuerzo, y solo
        // si el motor dice exactamente "esa tabla no existe".
        if (sentencia.optional === true && ctx.dialect.isMissingTableError(error)) continue;
        throw error;
      }
    }
    ctx.logger.success(`${tablas.length} tablas vaciadas y autoincrementales reseteados.`);

    if (options.seed !== true) return;

    // El TRUNCATE ha vaciado tambien la tabla del ledger, asi que todos los
    // seeders vuelven a estar pendientes. `ensureTable` sigue haciendo falta por
    // si la base no la tenia.
    await ctx.ledger.ensureTable();
    const report = await runSeeders(ctx);

    if (report.executed.length > 0) {
      ctx.logger.success(
        `${report.executed.length} seeders ejecutados (batch ${String(report.batch)}).`
      );
    }
  } finally {
    await closeContext(ctx);
  }
}

/**
 * Pregunta antes de destruir.
 *
 * Si stdin no es una terminal —CI, un `docker exec` sin `-it`, una tuberia— no
 * se puede preguntar. Ahi se falla pidiendo `--force` explicito, que es lo
 * seguro: asumir "si" en un entorno no interactivo es como se vacian bases por
 * accidente.
 */
async function confirmarDestruccion(tablas: string[]): Promise<void> {
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      'fresh vacia todas las tablas y no hay terminal para confirmarlo.',
      EXIT.USAGE,
      'Ejecuta con --force si de verdad es lo que quieres, o con --dry-run para ver que haria.'
    );
  }

  console.error(`Se van a VACIAR ${String(tablas.length)} tablas:`);
  for (const t of tablas) console.error(`  - ${t}`);

  const seguro = await confirm({
    message: 'Esto borra todas las filas. ¿Continuar?',
    default: false,
  });

  if (!seguro) {
    throw new CliError('Cancelado.', EXIT.USAGE);
  }
}
