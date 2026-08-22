import { describe, expect, it } from 'vitest';

import { getDialect } from '../../src/core/dialect/index.js';
import { CliError } from '../../src/core/errors.js';
import { listUserTables } from '../../src/core/tables.js';
import type { SeedClient } from '../../src/types.js';

/**
 * El inventario que usa `fresh` para saber que vaciar.
 *
 * Lo que se prueba aqui es el FILTRADO, que es donde esta el riesgo: dejar
 * pasar `_prisma_migrations` haria creer al ORM que no se ha migrado nada.
 */

function clienteQueDevuelve(nombres: string[]): SeedClient {
  return {
    $queryRawUnsafe: <T>(): Promise<T> =>
      Promise.resolve(nombres.map((name) => ({ name })) as unknown as T),
    $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),
  };
}

function clienteQueFalla(): SeedClient {
  return {
    $queryRawUnsafe: (): Promise<never> => Promise.reject(new Error('permiso denegado')),
    $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),
  };
}

const dialect = getDialect('postgresql');

describe('listUserTables', () => {
  it('devuelve las tablas de usuario ordenadas', async () => {
    const tablas = await listUserTables(clienteQueDevuelve(['Post', 'User', 'Tag']), dialect);
    expect(tablas).toEqual(['Post', 'Tag', 'User']);
  });

  /**
   * El filtro que de verdad importa. `_prisma_migrations` lo usan tanto Prisma
   * como ZenStack: vaciarlo hace que el siguiente `migrate deploy` intente
   * aplicarlo todo otra vez sobre un esquema que ya existe.
   */
  it('nunca toca el registro de migraciones', async () => {
    const tablas = await listUserTables(
      clienteQueDevuelve(['User', '_prisma_migrations', '_otra_interna']),
      dialect
    );
    expect(tablas).toEqual(['User']);
  });

  it('respeta las exclusiones del proyecto', async () => {
    const tablas = await listUserTables(clienteQueDevuelve(['User', 'Post', 'Catalogo']), dialect, {
      exclude: ['Catalogo'],
    });
    expect(tablas).toEqual(['Post', 'User']);
  });

  // La tabla del ledger SI entra: `fresh` deja la base como recien creada, y eso
  // incluye olvidar que seeders se aplicaron.
  it('incluye la tabla del ledger', async () => {
    const tablas = await listUserTables(clienteQueDevuelve(['SeedExecution', 'User']), dialect);
    expect(tablas).toContain('SeedExecution');
  });

  it('tolera una base sin tablas', async () => {
    expect(await listUserTables(clienteQueDevuelve([]), dialect)).toEqual([]);
  });

  it('convierte un fallo de la consulta en un error accionable', async () => {
    await expect(listUserTables(clienteQueFalla(), dialect)).rejects.toThrow(CliError);
    await expect(listUserTables(clienteQueFalla(), dialect)).rejects.toThrow(/listar las tablas/);
  });
});
