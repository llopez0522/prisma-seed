import { runInTransaction } from './client.js';
import type { ResolvedConfig } from './config.js';
import { isPolicyRejection } from './dialect/index.js';
import { CliError, EXIT, toMessage, UsageError } from './errors.js';
import type { Ledger } from './ledger.js';
import { loadSeederModule } from './loader.js';
import { discoverSeeders, findSeederByName } from './resolver.js';
import type { DiscoveredSeeder, Logger, SeedClient, SeedExecutionRecord } from '../types.js';

/**
 * Motor de ejecucion y reversion de seeders.
 *
 * Se separa de los comandos para que la logica sea testeable sin pasar por
 * commander, y para que `run`, `rollback` y `refresh` compartan exactamente el
 * mismo comportamiento.
 */

export interface RunnerDeps {
  config: ResolvedConfig;
  /** El cliente compartido. Uno solo para toda la ejecucion. */
  prisma: SeedClient;
  ledger: Ledger;
  logger: Logger;
}

export interface RunOptions {
  /** Ejecutar solo el seeder que coincida con este nombre. */
  only?: string | undefined;
  /** Ejecutar como mucho N seeders pendientes. */
  step?: number | undefined;
  /** Mostrar que se haria, sin tocar la base de datos. */
  dryRun?: boolean | undefined;
}

export interface RunReport {
  executed: string[];
  skipped: { name: string; reason: string }[];
  batch: number;
  dryRun: boolean;
}

/**
 * Ejecuta un seeder y registra su ejecucion.
 *
 * B7: ambas cosas ocurren dentro de la misma transaccion. En la v0.2.4 eran dos
 * operaciones sueltas, asi que un fallo entre medias dejaba el seeder aplicado
 * pero sin registrar, y la siguiente ejecucion lo repetia.
 */
async function applySeeder(
  deps: RunnerDeps,
  seeder: DiscoveredSeeder,
  batch: number
): Promise<void> {
  const { config, prisma, ledger, logger } = deps;
  const mod = await loadSeederModule(seeder.absolutePath);

  if (typeof mod.main !== 'function') {
    throw new CliError(
      `El seeder "${seeder.name}" no exporta una funcion "main".`,
      EXIT.FAILURE,
      'Cada seeder debe exportar main() para poder ejecutarse.'
    );
  }

  const main = mod.main;

  if (config.transactional) {
    await runInTransaction(
      prisma,
      async (tx) => {
        await main({ prisma: tx, client: tx, logger, name: seeder.name });
        await ledger.record(seeder.name, batch, tx);
      },
      { timeout: config.transactionTimeout }
    );
  } else {
    await main({ prisma, client: prisma, logger, name: seeder.name });
    await ledger.record(seeder.name, batch);
  }
}

/**
 * Convierte el fallo de un seeder en un error con una pista util.
 *
 * El caso que merece trato propio es el del control de acceso: un ORM que aplique
 * politicas a nivel de fila rechaza la operacion con `reason:
 * 'rejected-by-policy'`, y el mensaje por si solo no dice que el problema es el
 * cliente inyectado, no el seeder.
 */
function explainSeederFailure(name: string, error: unknown, done: string[]): CliError {
  const yaHechos = done.length > 0 ? `Ya se habian ejecutado: ${done.join(', ')}.` : undefined;

  if (isPolicyRejection(error)) {
    return new CliError(
      `El seeder "${name}" fue rechazado por una politica de acceso: ${toMessage(error)}`,
      EXIT.FAILURE,
      'El cliente inyectado aplica politicas de acceso. Un seed es trabajo de ' +
        'sistema: inyecta el cliente sin ellas, o uno atado a un usuario ' +
        'autorizado.'
    );
  }

  return new CliError(`Fallo el seeder "${name}": ${toMessage(error)}`, EXIT.FAILURE, yaHechos);
}

export async function runSeeders(deps: RunnerDeps, options: RunOptions = {}): Promise<RunReport> {
  const { config, ledger, logger } = deps;

  const todos = discoverSeeders(config.seedersDirAbsolute);
  if (todos.length === 0) {
    logger.warn(`No hay seeders en ${config.seedersDir}.`);
    return { executed: [], skipped: [], batch: 0, dryRun: options.dryRun === true };
  }

  const aplicados = await ledger.appliedNames();
  const skipped: RunReport['skipped'] = [];

  let candidatos: DiscoveredSeeder[];

  if (options.only !== undefined) {
    // La busqueda va sobre TODOS los seeders, no solo los pendientes: si el
    // usuario nombra uno ya ejecutado, merece un mensaje claro y no un
    // "no existe" enganoso.
    const elegido = findSeederByName(todos, options.only);
    if (aplicados.has(elegido.name)) {
      logger.warn(`"${elegido.name}" ya estaba ejecutado; no se vuelve a lanzar.`);
      logger.info(`Para repetirlo: prisma-seed rollback ${elegido.name} && ... run`);
      return {
        executed: [],
        skipped: [{ name: elegido.name, reason: 'ya ejecutado' }],
        batch: 0,
        dryRun: options.dryRun === true,
      };
    }
    candidatos = [elegido];
  } else {
    candidatos = todos.filter((s) => !aplicados.has(s.name));
    for (const s of todos) {
      if (aplicados.has(s.name)) skipped.push({ name: s.name, reason: 'ya ejecutado' });
    }
  }

  if (options.step !== undefined) {
    if (!Number.isInteger(options.step) || options.step < 1) {
      throw new UsageError(`--step debe ser un entero positivo, se recibio "${options.step}".`);
    }
    candidatos = candidatos.slice(0, options.step);
  }

  if (candidatos.length === 0) {
    logger.success('No hay seeders pendientes.');
    return { executed: [], skipped, batch: 0, dryRun: options.dryRun === true };
  }

  if (options.dryRun === true) {
    logger.info(`Se ejecutarian ${candidatos.length} seeders:`);
    for (const s of candidatos) logger.info(`  - ${s.name}`);
    return { executed: [], skipped, batch: 0, dryRun: true };
  }

  const batch = await ledger.nextBatch();
  const executed: string[] = [];

  for (const seeder of candidatos) {
    logger.debug(`Cargando ${seeder.absolutePath}`);
    try {
      await applySeeder(deps, seeder, batch);
      executed.push(seeder.name);
      logger.success(`${seeder.name}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw explainSeederFailure(seeder.name, error, executed);
    }
  }

  return { executed, skipped, batch, dryRun: false };
}

export interface RollbackOptions {
  /** Revertir solo el seeder indicado. */
  only?: string | undefined;
  /** Revertir los N ultimos ejecutados. */
  step?: number | undefined;
  /** Revertir todo el historico, no solo el ultimo batch. */
  all?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface RollbackReport {
  reverted: string[];
  skipped: { name: string; reason: string }[];
  dryRun: boolean;
}

/** Decide que registros hay que revertir segun las opciones. */
async function seleccionarParaRevertir(
  ledger: Ledger,
  options: RollbackOptions
): Promise<SeedExecutionRecord[]> {
  const historico = await ledger.all();

  if (options.only !== undefined) {
    const objetivo = options.only;
    const encontrado = historico.filter(
      (r) => r.seedName === objetivo || r.seedName.toLowerCase().includes(objetivo.toLowerCase())
    );

    if (encontrado.length === 0) {
      throw new UsageError(
        `"${objetivo}" no figura como ejecutado, asi que no hay nada que revertir.`,
        historico.length > 0
          ? `Ejecutados: ${historico.map((r) => r.seedName).join(', ')}`
          : 'El ledger esta vacio.'
      );
    }
    if (encontrado.length > 1) {
      throw new UsageError(
        `"${objetivo}" es ambiguo: coincide con ${encontrado.length} seeders ejecutados.`,
        `Concreta cual: ${encontrado.map((r) => r.seedName).join(', ')}`
      );
    }
    return encontrado;
  }

  if (options.all === true) return historico;

  if (options.step !== undefined) {
    if (!Number.isInteger(options.step) || options.step < 1) {
      throw new UsageError(`--step debe ser un entero positivo, se recibio "${options.step}".`);
    }
    return historico.slice(0, options.step);
  }

  // Por defecto, solo el ultimo batch: es el comportamiento de
  // `migrate:rollback` en Laravel. La v0.2.4 revertia siempre todo, que ahora
  // requiere --all de forma explicita.
  const ultimo = await ledger.lastBatch();
  return ultimo === 0 ? [] : ledger.byBatch(ultimo);
}

export async function rollbackSeeders(
  deps: RunnerDeps,
  options: RollbackOptions = {}
): Promise<RollbackReport> {
  const { config, prisma, ledger, logger } = deps;

  const objetivos = await seleccionarParaRevertir(ledger, options);
  const skipped: RollbackReport['skipped'] = [];

  if (objetivos.length === 0) {
    logger.success('No hay seeders que revertir.');
    return { reverted: [], skipped, dryRun: options.dryRun === true };
  }

  if (options.dryRun === true) {
    logger.info(`Se revertirian ${objetivos.length} seeders:`);
    for (const r of objetivos) logger.info(`  - ${r.seedName} (batch ${r.batch})`);
    return { reverted: [], skipped, dryRun: true };
  }

  const enDisco = new Map(
    discoverSeeders(config.seedersDirAbsolute).map((s) => [s.name, s] as const)
  );
  const reverted: string[] = [];

  for (const registro of objetivos) {
    const seeder = enDisco.get(registro.seedName);

    if (!seeder) {
      // No se borra el registro: dejarlo permite reconstruir el archivo y
      // revertirlo mas tarde. Eliminarlo en silencio perderia esa informacion.
      logger.warn(
        `No se encuentra el archivo de "${registro.seedName}"; se deja registrado como ejecutado.`
      );
      skipped.push({ name: registro.seedName, reason: 'archivo ausente' });
      continue;
    }

    const mod = await loadSeederModule(seeder.absolutePath);
    if (typeof mod.down !== 'function') {
      logger.warn(`"${registro.seedName}" no exporta "down"; no se puede revertir.`);
      skipped.push({ name: registro.seedName, reason: 'sin funcion down' });
      continue;
    }

    const down = mod.down;

    try {
      if (config.transactional) {
        await runInTransaction(
          prisma,
          async (tx) => {
            await down({ prisma: tx, client: tx, logger, name: registro.seedName });
            await ledger.remove(registro.seedName, tx);
          },
          { timeout: config.transactionTimeout }
        );
      } else {
        await down({ prisma, client: prisma, logger, name: registro.seedName });
        await ledger.remove(registro.seedName);
      }

      reverted.push(registro.seedName);
      logger.success(`${registro.seedName} revertido`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (isPolicyRejection(error)) {
        throw explainSeederFailure(registro.seedName, error, reverted);
      }
      throw new CliError(
        `Fallo al revertir "${registro.seedName}": ${toMessage(error)}`,
        EXIT.FAILURE,
        reverted.length > 0 ? `Ya se habian revertido: ${reverted.join(', ')}.` : undefined
      );
    }
  }

  return { reverted, skipped, dryRun: false };
}
