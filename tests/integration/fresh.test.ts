import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getDialect } from '../../src/core/dialect/index.js';
import { listUserTables } from '../../src/core/tables.js';
import { clientFor, ENGINES, type Engine, type TestPrismaClient } from './helpers/clients.js';

/**
 * El vaciado de `fresh` contra bases reales.
 *
 * Lo que hay que demostrar aqui no es que el DELETE borre filas —eso es
 * trivial— sino que **el autoincremental vuelve a empezar en 1**. Es lo que pide
 * el caso de uso (repetir una prueba y obtener los mismos ids) y es donde cada
 * motor hace algo distinto: `RESTART IDENTITY` en Postgres, TRUNCATE a secas en
 * MySQL, `sqlite_sequence` en SQLite.
 *
 * Se vacian SOLO las tablas de este test, no todas las que descubre
 * `listUserTables`: la base es compartida con el resto de la suite.
 */

const A = 'psc_fresh_a';
const B = 'psc_fresh_b';

const clients = new Map<Engine, TestPrismaClient>();

function client(engine: Engine): TestPrismaClient {
  let c = clients.get(engine);
  if (!c) {
    c = clientFor(engine);
    clients.set(engine, c);
  }
  return c;
}

/** DDL con autoincremental. Es lo unico irreductiblemente distinto por motor. */
const CREAR: Record<Engine, (t: string) => string> = {
  postgresql: (t) => `CREATE TABLE "${t}" ("id" SERIAL PRIMARY KEY, "v" VARCHAR(20))`,
  mysql: (t) => `CREATE TABLE \`${t}\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`v\` VARCHAR(20))`,
  sqlite: (t) => `CREATE TABLE "${t}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "v" VARCHAR(20))`,
};

afterAll(async () => {
  for (const [engine, c] of clients) {
    const d = getDialect(engine);
    await c.$executeRawUnsafe(`DROP TABLE IF EXISTS ${d.quote(A)}`);
    await c.$executeRawUnsafe(`DROP TABLE IF EXISTS ${d.quote(B)}`);
    await c.$disconnect();
  }
});

describe.each(ENGINES)('fresh sobre %s', (engine) => {
  const dialect = getDialect(engine);
  const db = (): TestPrismaClient => client(engine);

  async function insertar(tabla: string, valor: string): Promise<void> {
    await db().$executeRawUnsafe(
      `INSERT INTO ${dialect.quote(tabla)} (${dialect.quote('v')}) VALUES (${dialect.placeholder(1)})`,
      valor
    );
  }

  async function ids(tabla: string): Promise<number[]> {
    const filas = await db().$queryRawUnsafe<{ id: number | bigint }[]>(
      `SELECT ${dialect.quote('id')} FROM ${dialect.quote(tabla)} ORDER BY ${dialect.quote('id')}`
    );
    return filas.map((f) => Number(f.id));
  }

  beforeEach(async () => {
    for (const t of [A, B]) {
      await db().$executeRawUnsafe(`DROP TABLE IF EXISTS ${dialect.quote(t)}`);
      await db().$executeRawUnsafe(CREAR[engine](t));
    }
    await insertar(A, 'uno');
    await insertar(A, 'dos');
    await insertar(B, 'uno');
  });

  it('las tablas de prueba aparecen en el inventario', async () => {
    const tablas = await listUserTables(db(), dialect);

    expect(tablas).toContain(A);
    expect(tablas).toContain(B);
  });

  it('el inventario no incluye tablas internas del motor', async () => {
    const tablas = await listUserTables(db(), dialect);

    expect(tablas.some((t) => t.startsWith('sqlite_'))).toBe(false);
    expect(tablas.some((t) => t.startsWith('_'))).toBe(false);
  });

  it('respeta las exclusiones', async () => {
    const tablas = await listUserTables(db(), dialect, { exclude: [B] });

    expect(tablas).toContain(A);
    expect(tablas).not.toContain(B);
  });

  it('vacia todas las tablas indicadas', async () => {
    expect(await ids(A)).toEqual([1, 2]);

    for (const s of dialect.truncateAll([A, B])) await db().$executeRawUnsafe(s.sql);

    expect(await ids(A)).toEqual([]);
    expect(await ids(B)).toEqual([]);
  });

  /** El objeto real del comando: repetir una prueba y obtener los mismos ids. */
  it('resetea el autoincremental: la siguiente fila vuelve a ser id 1', async () => {
    for (const s of dialect.truncateAll([A, B])) await db().$executeRawUnsafe(s.sql);

    await insertar(A, 'despues');
    await insertar(B, 'despues');

    expect(await ids(A)).toEqual([1]);
    expect(await ids(B)).toEqual([1]);
  });

  it('vaciar dos veces seguidas no falla', async () => {
    for (const s of dialect.truncateAll([A, B])) await db().$executeRawUnsafe(s.sql);
    for (const s of dialect.truncateAll([A, B])) await db().$executeRawUnsafe(s.sql);

    expect(await ids(A)).toEqual([]);
  });
});
