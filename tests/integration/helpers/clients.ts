import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Provider, SeedClient } from '../../../src/types.js';

/**
 * Clientes de Prisma para los tres motores que levanta docker-compose.
 *
 * Cada fixture tiene su propio cliente generado (el provider se fija en el
 * schema.prisma), asi que hay que resolver `@prisma/client` desde el fixture que
 * corresponde y no desde la raiz.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../.fixtures');

/**
 * Cliente de las pruebas de integracion.
 *
 * `SeedClient` deja `$transaction` y `$disconnect` como capacidades opcionales,
 * porque hay clientes validos que no las tienen. Aqui si las tenemos: los
 * fixtures son PrismaClient de verdad. Se declara la forma concreta para que las
 * pruebas puedan invocarlas sin comprobaciones ni casts.
 */
export interface TestPrismaClient extends SeedClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<R>(
    fn: (tx: SeedClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<R>;
}

interface Ctor {
  PrismaClient: new (options?: { datasourceUrl?: string }) => TestPrismaClient;
}

const FIXTURE_DIR: Record<Exclude<Provider, 'sqlserver'>, string> = {
  postgresql: 'pg-cjs',
  mysql: 'mysql-cjs',
  sqlite: 'sqlite-cjs',
};

const URL_ENV: Record<Exclude<Provider, 'sqlserver'>, string> = {
  postgresql: 'POSTGRES_URL',
  mysql: 'MYSQL_URL',
  sqlite: 'SQLITE_URL',
};

/** Motores que se ejercitan en la suite de integracion. */
export const ENGINES = ['postgresql', 'mysql', 'sqlite'] as const;
export type Engine = (typeof ENGINES)[number];

export function urlFor(engine: Engine): string {
  const url = process.env[URL_ENV[engine]];
  if (!url) {
    throw new Error(
      `Falta la variable ${URL_ENV[engine]}. Ejecuta los tests dentro de Docker: ./dx npm run test:integration`
    );
  }
  return url;
}

export function clientFor(engine: Engine): TestPrismaClient {
  const dir = path.join(fixtures, FIXTURE_DIR[engine]);
  const requireFromFixture = createRequire(path.join(dir, 'noop.js'));
  const { PrismaClient } = requireFromFixture('@prisma/client') as Ctor;

  return new PrismaClient({ datasourceUrl: urlFor(engine) });
}
