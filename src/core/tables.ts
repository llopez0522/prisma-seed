import type { Dialect } from './dialect/index.js';
import { CliError, EXIT, toMessage } from './errors.js';
import type { SeedClient } from '../types.js';

/**
 * Inventario de tablas de la base.
 *
 * Existe para `fresh`, que necesita saber que vaciar. Es la unica parte de la
 * libreria que mira la base mas alla de su propia tabla de control, asi que la
 * lista de exclusiones vive aqui y no repartida.
 */

/**
 * Tablas que `fresh` NUNCA toca, por prefijo.
 *
 * `_prisma_migrations` es el registro de migraciones aplicadas — lo usan tanto
 * Prisma como ZenStack, que delega en el motor de migraciones de Prisma.
 * Vaciarlo haria creer al ORM que no se ha migrado nada, y el siguiente
 * `migrate deploy` intentaria aplicarlo todo otra vez sobre un esquema que ya
 * existe. El prefijo `_` es la convencion de ambos para este tipo de tabla.
 */
const PREFIJOS_RESERVADOS = ['_'] as const;

function esReservada(table: string): boolean {
  return PREFIJOS_RESERVADOS.some((prefijo) => table.startsWith(prefijo));
}

export interface ListTablesOptions {
  /** Nombres adicionales que no hay que tocar. */
  exclude?: readonly string[] | undefined;
}

/**
 * Devuelve las tablas que `fresh` puede vaciar, ya filtradas y ordenadas.
 *
 * La tabla del ledger SI entra: el objetivo de `fresh` es dejar la base como
 * recien creada, y eso incluye olvidar que seeders se aplicaron.
 */
export async function listUserTables(
  client: SeedClient,
  dialect: Dialect,
  options: ListTablesOptions = {}
): Promise<string[]> {
  const { sql, params } = dialect.listTables();

  let rows: { name: string }[];
  try {
    rows = await client.$queryRawUnsafe<{ name: string }[]>(sql, ...params);
  } catch (error) {
    throw new CliError(
      `No se pudo listar las tablas de la base: ${toMessage(error)}`,
      EXIT.CONNECTION
    );
  }

  const excluidas = new Set(options.exclude ?? []);

  return rows
    .map((row) => row.name)
    .filter((name) => typeof name === 'string' && name !== '')
    .filter((name) => !esReservada(name))
    .filter((name) => !excluidas.has(name))
    .sort((a, b) => a.localeCompare(b));
}
