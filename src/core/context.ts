import { disconnectClient, resolveSeedClient } from './client.js';
import { loadConfig, type ResolvedConfig } from './config.js';
import { getDialect, type Dialect } from './dialect/index.js';
import { Ledger } from './ledger.js';
import { createLogger } from './logger.js';
import { disconnectPrisma } from './prisma.js';
import { findProjectRoot } from './project.js';
import { readProvider } from './schema.js';
import type { Logger, SeedClient, SeedClientCapabilities, UserSeederConfig } from '../types.js';

/**
 * Montaje del entorno de ejecucion, compartido por el CLI y por la API
 * programatica.
 *
 * Vive en `core/` y no en `commands/` a proposito: `api.ts` no debe depender de
 * la capa de comandos, y la regla de dependencias del proyecto es que `core/`
 * nunca importa de `commands/`.
 *
 * Aqui esta el punto exacto donde se decide **un solo cliente para todo el
 * proceso**: se resuelve una vez, se le pasa al ledger y el runner lo inyecta en
 * cada seeder. Ningun otro modulo construye clientes.
 */

export interface SeedRuntimeOptions {
  /**
   * Raiz del proyecto. Por defecto se busca subiendo desde `process.cwd()`.
   * Si se pasa un valor explicito, se respeta tal cual.
   */
  cwd?: string | undefined;
  /** Cliente ya construido. Es el camino de la API programatica. */
  client?: SeedClient | undefined;
  /** Overrides de configuracion (los flags del CLI llegan por aqui). */
  config?: UserSeederConfig | undefined;
  logger?: Logger | undefined;
}

export interface SeedRuntime {
  config: ResolvedConfig;
  /** El cliente compartido. Misma referencia en el ledger y en cada seeder. */
  client: SeedClient;
  /** Alias historico de `client`. Es el mismo objeto. */
  prisma: SeedClient;
  /** Que sabe hacer el cliente. Se consulta, no se supone. */
  capabilities: SeedClientCapabilities;
  dialect: Dialect;
  ledger: Ledger;
  logger: Logger;
  /** De donde salio el cliente. */
  origin: 'injected' | 'config' | 'auto';
  /** Si lo construyo la libreria, y por tanto le toca a ella cerrarlo. */
  createdByLibrary: boolean;
}

/**
 * Resuelve la raiz del proyecto.
 *
 * Un `--cwd` explicito se respeta sin tocar. Sin el, se sube desde el directorio
 * actual hasta la primera carpeta con pinta de raiz, para que `pnpm seed` desde
 * un subdirectorio siga encontrando `prisma/seeders`.
 */
export function resolveProjectRoot(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  return findProjectRoot(process.cwd());
}

export async function createSeedRuntime(options: SeedRuntimeOptions = {}): Promise<SeedRuntime> {
  const cwd = resolveProjectRoot(options.cwd);
  const logger = options.logger ?? createLogger();

  const config = await loadConfig(cwd, options.config ?? {});

  // El provider explicito gana; si no, se lee del schema (.prisma o .zmodel).
  const provider = config.provider ?? readProvider(config.schemaPathAbsolute);
  const dialect = getDialect(provider);

  const { client, capabilities, origin, createdByLibrary } = await resolveSeedClient({
    cwd,
    source: config.client,
    injected: options.client,
    logger,
  });

  const ledger = new Ledger({ prisma: client, dialect, table: config.ledgerTable });

  logger.debug(`Proyecto: ${cwd}`);
  logger.debug(`Motor: ${provider}`);
  logger.debug(
    `Schema: ${config.schemaPathAbsolute}${config.schemaPathDetected ? ' (autodetectado)' : ''}`
  );
  logger.debug(`Seeders: ${config.seedersDirAbsolute}`);
  logger.debug(`Ledger: ${config.ledgerTable}`);
  if (config.sourceFile) logger.debug(`Configuracion: ${config.sourceFile}`);

  if (config.transactional && !capabilities.transactions) {
    logger.warn(
      'El cliente no expone $transaction: los seeders se aplicaran sin envolver. ' +
        'Un fallo a mitad puede dejar datos a medias.'
    );
  }

  return {
    config,
    client,
    prisma: client,
    capabilities,
    dialect,
    ledger,
    logger,
    origin,
    createdByLibrary,
  };
}

export interface ReleaseOptions {
  /**
   * Cerrar tambien un cliente que la libreria no creo.
   *
   * Lo activa el CLI, que es dueno del proceso y tiene que dejarlo terminar. La
   * API programatica no lo usa nunca: quien presta el cliente sigue usandolo
   * despues.
   */
  force?: boolean;
}

/**
 * Cierra el cliente segun quien sea su dueno.
 *
 * Reglas, en este orden:
 *   1. Si lo creo la libreria, lo cierra siempre.
 *   2. Si `closeClient: false` en la configuracion, no lo toca.
 *   3. Si `force`, lo cierra (caso del CLI).
 *   4. En cualquier otro caso, lo deja abierto.
 */
export async function releaseSeedRuntime(
  runtime: SeedRuntime,
  options: ReleaseOptions = {}
): Promise<void> {
  if (runtime.createdByLibrary) {
    // Pasa por `disconnectPrisma` para que el cliente memoizado del modulo
    // tambien se olvide; si no, la siguiente resolucion devolveria uno cerrado.
    await disconnectPrisma();
    return;
  }

  if (runtime.config.closeClient === false) {
    runtime.logger.debug('closeClient=false: el cliente inyectado se deja abierto.');
    return;
  }

  if (options.force !== true) return;

  await disconnectClient(runtime.client);
}
