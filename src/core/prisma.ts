import { createRequire } from 'node:module';
import path from 'node:path';

import { ConnectionError, toMessage } from './errors.js';
import type { SeedClient } from '../types.js';

/**
 * Construccion automatica del cliente para proyectos con **Prisma tradicional**.
 *
 * Es uno de los dos caminos posibles, y el de menor prioridad: si la
 * configuracion declara `client`, `core/client.ts` ni llega a llamar aqui. Este
 * modulo cubre el caso de siempre — un proyecto con `@prisma/client` generado
 * cuyo cliente se construye con `new PrismaClient()` — y no sabe nada de
 * ZenStack ni de driver adapters.
 *
 * Cambios respecto de la v0.2.4:
 *
 *  - **Perezoso** (B4). Antes `getPrismaClient()` se invocaba en el cuerpo de
 *    `run-seeds.js` y `down-seeds.js`, y `cli.js` importaba ambos siempre. Con eso
 *    `generate` abria dos pools de conexion y abortaba si faltaba `@prisma/client`,
 *    pese a que generar un archivo no toca la base de datos. Ahora el cliente se
 *    construye la primera vez que alguien lo pide, y solo una vez.
 *  - **Lanza en vez de `process.exit`**. Un modulo de libreria no debe matar el
 *    proceso: impide testearlo y secuestra la decision del punto de entrada.
 *  - **Una sola instancia**, compartida e inyectada en los seeders, en lugar de
 *    una por modulo mas una por seeder generado (B12).
 */

let client: SeedClient | null = null;
let resolvedFrom: string | null = null;

interface PrismaClientModule {
  PrismaClient: new (options?: unknown) => SeedClient;
}

/**
 * Resuelve `@prisma/client` desde el proyecto del usuario, no desde esta libreria.
 *
 * Es la parte que la v0.2.4 ya hacia bien y se conserva: si se resolviera de forma
 * relativa al CLI se cargaria un cliente sin los modelos generados del usuario.
 */
function resolveUserPrisma(cwd: string): PrismaClientModule {
  // El require se ancla a un archivo dentro del cwd para que la resolucion suba
  // por los node_modules del proyecto del usuario.
  const requireFromProject = createRequire(path.join(cwd, 'noop.js'));

  let entry: string;
  try {
    entry = requireFromProject.resolve('@prisma/client');
  } catch (error) {
    throw new ConnectionError(
      `No se encontro "@prisma/client" en ${cwd}: ${toMessage(error)}`,
      'Instalalo con: npm install @prisma/client  (y genera el cliente con: npx prisma generate)'
    );
  }

  const mod = requireFromProject(entry) as Partial<PrismaClientModule>;
  if (typeof mod.PrismaClient !== 'function') {
    throw new ConnectionError(
      `El modulo "@prisma/client" de ${cwd} no exporta PrismaClient.`,
      'Ejecuta: npx prisma generate'
    );
  }

  return mod as PrismaClientModule;
}

/**
 * Si el proyecto puede resolver `@prisma/client`.
 *
 * Es una pregunta sobre el PROYECTO, no sobre ninguna marca de ORM: la usa
 * `generate` para decidir si el seeder TypeScript puede importar `PrismaClient`
 * sin generar codigo que no compila.
 */
export function hasPrismaClient(cwd: string): boolean {
  try {
    createRequire(path.join(cwd, 'noop.js')).resolve('@prisma/client');
    return true;
  } catch {
    return false;
  }
}

export interface GetPrismaOptions {
  /** Raiz del proyecto del usuario. Por defecto, el cwd del proceso. */
  cwd?: string;
}

/** Devuelve el cliente compartido, creandolo la primera vez. */
export function getPrismaClient(options: GetPrismaOptions = {}): SeedClient {
  const cwd = options.cwd ?? process.cwd();

  if (client && resolvedFrom === cwd) return client;
  if (client && resolvedFrom !== cwd) {
    // Cambiar de proyecto a mitad de proceso solo pasa en tests; se reinicia.
    void client.$disconnect?.();
    client = null;
  }

  const { PrismaClient: Ctor } = resolveUserPrisma(cwd);
  client = new Ctor();
  resolvedFrom = cwd;
  return client;
}

/** Cierra el cliente si llego a crearse. Idempotente. */
export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  resolvedFrom = null;
  await current.$disconnect?.();
}

/** Solo para tests: olvida el cliente memoizado sin desconectar. */
export function resetPrismaForTests(): void {
  client = null;
  resolvedFrom = null;
}
