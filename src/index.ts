/**
 * API publica del paquete.
 *
 * Hasta la 1.0.0-beta esto eran solo tipos y `defineConfig`. Ahora expone tambien
 * la API programatica, que es la forma de usar la libreria cuando el cliente lo
 * construye el proyecto.
 */

export { rollbackSeeders, runSeeders } from './api.js';
export type {
  RollbackReport,
  RollbackSeedersOptions,
  RunReport,
  RunSeedersOptions,
  SeedApiOptions,
} from './api.js';

export { defineConfig } from './types.js';
export type {
  DiscoveredSeeder,
  Logger,
  PrismaLike,
  Provider,
  RawSqlClient,
  SeedClient,
  SeedClientCapabilities,
  SeedClientFactory,
  SeedClientSource,
  SeedContext,
  SeedExecutionRecord,
  SeedTransactionOptions,
  SeederConfig,
  SeederModule,
  UserSeederConfig,
} from './types.js';

/**
 * Utilidades de bajo nivel.
 *
 * Un proyecto que inyecta su propio cliente puede querer validarlo antes de
 * pasarlo (`assertSeedClient`) o consultar sus capacidades (`capabilitiesOf`).
 * No hacen falta para el uso normal.
 */
export { assertSeedClient, capabilitiesOf, supportsTransactions } from './core/client.js';
export { createLogger, silentLogger } from './core/logger.js';
export type { LogLevel, LoggerOptions } from './core/logger.js';
