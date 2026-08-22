import {
  createSeedRuntime,
  releaseSeedRuntime,
  type SeedRuntime,
  type SeedRuntimeOptions,
} from './core/context.js';
import {
  rollbackSeeders as rollbackWithRuntime,
  runSeeders as runWithRuntime,
  type RollbackReport,
  type RunReport,
} from './core/runner.js';
import type { Logger, SeedClient, UserSeederConfig } from './types.js';

/**
 * API programatica.
 *
 * Es el punto de entrada pensado para un `prisma/seed.ts` o un script propio, y
 * la razon de ser de todo el rediseno: **el cliente se inyecta**.
 *
 * ```ts
 * // Prisma tradicional
 * import { PrismaClient } from '@prisma/client';
 * import { runSeeders } from 'prisma-seed';
 *
 * const prisma = new PrismaClient();
 * await runSeeders(prisma);
 * await prisma.$disconnect();
 * ```
 *
 * ```ts
 * // Cualquier otro cliente que cumpla el contrato (p. ej. ZenStackClient)
 * import { runSeeders } from 'prisma-seed';
 * import { db } from './src/db';
 *
 * await runSeeders(db);
 * await db.$disconnect();
 * ```
 *
 * Dos reglas que no cambian:
 *
 *  - **Un solo cliente.** El que se pasa aqui es el que reciben el ledger y todos
 *    los seeders. La libreria no crea ninguno mas.
 *  - **No se cierra lo prestado.** Estas funciones nunca llaman a `$disconnect()`
 *    sobre un cliente que no han creado: quien lo abrio decide cuando cerrarlo.
 *    El CLI si lo cierra, porque ahi el dueno del proceso es el.
 */

export interface SeedApiOptions {
  /** Raiz del proyecto. Por defecto se busca subiendo desde `process.cwd()`. */
  cwd?: string | undefined;
  /** Overrides de configuracion: `seedersDir`, `provider`, `ledgerTable`... */
  config?: UserSeederConfig | undefined;
  /** Logger propio. Por defecto, el de la libreria en nivel normal. */
  logger?: Logger | undefined;
  /**
   * Crear o migrar la tabla del ledger antes de empezar. Por defecto `true`.
   *
   * Es lo que hace el comando `run`. Ponerlo a `false` sirve si el esquema lo
   * gestionan las migraciones del proyecto.
   */
  ensureLedgerTable?: boolean | undefined;
}

export interface RunSeedersOptions extends SeedApiOptions {
  /** Ejecutar solo el seeder que coincida con este nombre. */
  only?: string | undefined;
  /** Ejecutar como mucho N seeders pendientes. */
  step?: number | undefined;
  /** Mostrar que se haria, sin tocar la base de datos. */
  dryRun?: boolean | undefined;
}

export interface RollbackSeedersOptions extends SeedApiOptions {
  /** Revertir solo el seeder indicado. */
  only?: string | undefined;
  /** Revertir los N ultimos ejecutados. */
  step?: number | undefined;
  /** Revertir todo el historico, no solo el ultimo batch. */
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
}

function runtimeOptions(client: SeedClient, options: SeedApiOptions): SeedRuntimeOptions {
  return {
    client,
    cwd: options.cwd,
    config: options.config,
    logger: options.logger,
  };
}

/**
 * Ejecuta los seeders pendientes con el cliente que se le pase.
 *
 * Devuelve el informe de lo ocurrido en lugar de escribir en stdout y salir: es
 * una funcion de libreria, no un comando.
 */
export async function runSeeders(
  client: SeedClient,
  options: RunSeedersOptions = {}
): Promise<RunReport> {
  const runtime = await createSeedRuntime(runtimeOptions(client, options));

  try {
    if (options.ensureLedgerTable !== false) await prepareLedger(runtime);

    return await runWithRuntime(runtime, {
      only: options.only,
      step: options.step,
      dryRun: options.dryRun,
    });
  } finally {
    // Sin `force`: solo cierra si lo hubiera creado la libreria, que en esta ruta
    // nunca ocurre. El cliente prestado sigue vivo para quien llamo.
    await releaseSeedRuntime(runtime);
  }
}

/** Revierte seeders ya ejecutados con el cliente que se le pase. */
export async function rollbackSeeders(
  client: SeedClient,
  options: RollbackSeedersOptions = {}
): Promise<RollbackReport> {
  const runtime = await createSeedRuntime(runtimeOptions(client, options));

  try {
    if (!(await runtime.ledger.tableExists())) {
      runtime.logger.warn(
        `La tabla "${runtime.config.ledgerTable}" no existe: no hay nada registrado que revertir.`
      );
      return { reverted: [], skipped: [], dryRun: options.dryRun === true };
    }
    if (options.ensureLedgerTable !== false) await runtime.ledger.ensureTable();

    return await rollbackWithRuntime(runtime, {
      only: options.only,
      step: options.step,
      all: options.all,
      dryRun: options.dryRun,
    });
  } finally {
    await releaseSeedRuntime(runtime);
  }
}

async function prepareLedger(runtime: SeedRuntime): Promise<void> {
  const { created, migrated } = await runtime.ledger.ensureTable();
  if (created) runtime.logger.info(`Tabla "${runtime.config.ledgerTable}" creada.`);
  if (migrated) {
    runtime.logger.info(
      `Tabla "${runtime.config.ledgerTable}" migrada: se anadio la columna "batch".`
    );
  }
}

export type { RollbackReport, RunReport };
