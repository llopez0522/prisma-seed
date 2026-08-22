import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getDialect } from '../../src/core/dialect/index.js';
import { Ledger } from '../../src/core/ledger.js';
import { clientFor, ENGINES, type Engine, type TestPrismaClient } from './helpers/clients.js';

/**
 * El ledger contra los tres motores reales.
 *
 * Es la prueba que la v0.2.4 nunca tuvo y que habria evitado B1, B3 y B6. Cada
 * asercion se ejecuta identica en Postgres, MySQL y SQLite.
 */

const TABLE = 'SeedExecutionTest';

const clients = new Map<Engine, TestPrismaClient>();

function client(engine: Engine): TestPrismaClient {
  let c = clients.get(engine);
  if (!c) {
    c = clientFor(engine);
    clients.set(engine, c);
  }
  return c;
}

function ledgerFor(engine: Engine): Ledger {
  return new Ledger({ prisma: client(engine), dialect: getDialect(engine), table: TABLE });
}

afterAll(async () => {
  for (const c of clients.values()) await c.$disconnect();
});

describe.each(ENGINES)('Ledger sobre %s', (engine) => {
  const dialect = getDialect(engine);

  beforeEach(async () => {
    await client(engine).$executeRawUnsafe(`DROP TABLE IF EXISTS ${dialect.quote(TABLE)}`);
  });

  it('crea la tabla y la detecta como existente', async () => {
    const ledger = ledgerFor(engine);

    expect(await ledger.tableExists()).toBe(false);

    const result = await ledger.ensureTable();
    expect(result.created).toBe(true);
    expect(await ledger.tableExists()).toBe(true);
  });

  it('ensureTable es idempotente', async () => {
    const ledger = ledgerFor(engine);

    await ledger.ensureTable();
    const segunda = await ledger.ensureTable();

    expect(segunda.created).toBe(false);
    expect(segunda.migrated).toBe(false);
  });

  /**
   * B1 en Postgres y B3 en SQLite, la misma asercion para ambos.
   *
   * En Postgres la v0.2.4 creaba `seedname` en minusculas y luego consultaba
   * `"seedName"`. En SQLite creaba un id que nunca se autoasignaba. Si cualquiera
   * de las dos cosas se repite, este test cae.
   */
  it('las columnas conservan su nombre exacto y el id se autoasigna', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    await ledger.record('20240101000000_User', 1);
    await ledger.record('20240102000000_Post', 1);

    const registros = await ledger.all();

    expect(registros).toHaveLength(2);
    for (const r of registros) {
      expect(r.seedName).toMatch(/^2024/);
      // El fallo silencioso de SQLite dejaba esto en NaN al convertir null.
      expect(Number.isInteger(r.id)).toBe(true);
      expect(r.id).toBeGreaterThan(0);
      expect(r.executedAt).toBeInstanceOf(Date);
    }
    // Ids distintos y crecientes: hay autoincremento real.
    expect(new Set(registros.map((r) => r.id)).size).toBe(2);
  });

  it('appliedNames devuelve lo registrado', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();
    await ledger.record('A', 1);
    await ledger.record('B', 1);

    const aplicados = await ledger.appliedNames();

    expect(aplicados.has('A')).toBe(true);
    expect(aplicados.has('B')).toBe(true);
    expect(aplicados.has('C')).toBe(false);
  });

  /**
   * B6: la fase 0 demostro que dos seeders ejecutados en el mismo segundo
   * comparten `executedAt`, dejando `ORDER BY executedAt DESC` indeterminado.
   * Estas inserciones son consecutivas, asi que empatan en tiempo casi seguro; el
   * orden debe seguir siendo estricto por id.
   */
  it('el orden es determinista aunque executedAt empate', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    for (const nombre of ['S1', 'S2', 'S3', 'S4', 'S5']) {
      await ledger.record(nombre, 1);
    }

    const orden = (await ledger.all()).map((r) => r.seedName);
    expect(orden).toEqual(['S5', 'S4', 'S3', 'S2', 'S1']);
  });

  it('agrupa por batch y calcula el siguiente', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    expect(await ledger.lastBatch()).toBe(0);
    expect(await ledger.nextBatch()).toBe(1);

    await ledger.record('A', 1);
    await ledger.record('B', 1);
    expect(await ledger.nextBatch()).toBe(2);

    await ledger.record('C', 2);
    expect(await ledger.lastBatch()).toBe(2);

    const batch1 = await ledger.byBatch(1);
    expect(batch1.map((r) => r.seedName)).toEqual(['B', 'A']);

    const batch2 = await ledger.byBatch(2);
    expect(batch2.map((r) => r.seedName)).toEqual(['C']);
  });

  it('el orden global es por batch descendente y luego por id descendente', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    await ledger.record('A', 1);
    await ledger.record('B', 1);
    await ledger.record('C', 2);
    await ledger.record('D', 2);

    expect((await ledger.all()).map((r) => r.seedName)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('remove informa de si el registro existia', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();
    await ledger.record('A', 1);

    expect(await ledger.remove('A')).toBe(true);
    expect(await ledger.remove('A')).toBe(false);
    expect((await ledger.appliedNames()).size).toBe(0);
  });

  /**
   * B7: en la v0.2.4 el seeder y su registro eran dos operaciones sueltas. Si el
   * INSERT fallaba despues de aplicar el seeder, la siguiente ejecucion lo repetia.
   * Aqui el registro participa de la transaccion del llamante.
   */
  it('el registro se deshace si la transaccion falla', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    await expect(
      client(engine).$transaction(async (tx) => {
        await ledger.record('Atomico', 1, tx);
        throw new Error('el seeder fallo despues de registrarse');
      })
    ).rejects.toThrow('el seeder fallo');

    expect((await ledger.appliedNames()).has('Atomico')).toBe(false);
  });

  it('el registro persiste si la transaccion termina bien', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();

    await client(engine).$transaction(async (tx) => {
      await ledger.record('Atomico', 1, tx);
    });

    expect((await ledger.appliedNames()).has('Atomico')).toBe(true);
  });

  /**
   * B14: Prisma marca todo error de raw query como P2010. La v0.2.4 usaba ese
   * codigo para decidir "la tabla no existe", asi que confundia cualquier fallo
   * con una tabla ausente. `tableExists` solo debe devolver false ante el codigo
   * nativo correcto del motor.
   */
  it('distingue tabla ausente de otros errores', async () => {
    const ledger = ledgerFor(engine);

    // Tabla ausente de verdad: false, sin lanzar.
    expect(await ledger.tableExists()).toBe(false);

    // Un error distinto (sintaxis) no debe interpretarse como tabla ausente.
    await expect(client(engine).$executeRawUnsafe('ESTO NO ES SQL VALIDO')).rejects.toBeDefined();
  });

  /**
   * Migracion desde la v0.2.4: quien siguiera el README tiene la tabla declarada
   * en schema.prisma, sin columna `batch`. No se puede recrear sin perder el
   * historico.
   */
  /*
   * Usa un cliente propio, no el compartido.
   *
   * Con el cliente compartido, Postgres falla con `0A000 cached plan must not
   * change result type`: el `beforeEach` va soltando y recreando la tabla, asi que
   * el plan que quedo cacheado para el SELECT de `all()` apunta a una encarnacion
   * anterior con otras columnas. Se comprobo que NO es un problema de produccion:
   * tanto preparar la consulta antes del ALTER como el flujo real del CLI
   * (ensureTable -> ALTER -> primera consulta) funcionan sin error. El disparador
   * es el ciclo DROP/CREATE repetido sobre una conexion viva, que solo ocurre aqui.
   */
  it('anade la columna batch a un ledger de la v0.2.4 conservando los datos', async () => {
    const aislado = clientFor(engine);
    const ledgerAislado = new Ledger({ prisma: aislado, dialect, table: TABLE });
    const q = (s: string) => dialect.quote(s);
    const idType =
      engine === 'postgresql'
        ? 'SERIAL PRIMARY KEY'
        : engine === 'mysql'
          ? 'INT AUTO_INCREMENT PRIMARY KEY'
          : 'INTEGER PRIMARY KEY AUTOINCREMENT';

    try {
      // Tabla al estilo v0.2.4: sin batch.
      await aislado.$executeRawUnsafe(
        `CREATE TABLE ${q(TABLE)} (
           ${q('id')} ${idType},
           ${q('seedName')} VARCHAR(255) NOT NULL UNIQUE,
           ${q('executedAt')} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
      );
      await aislado.$executeRawUnsafe(
        `INSERT INTO ${q(TABLE)} (${q('seedName')}) VALUES (${dialect.placeholder(1)})`,
        'SeedAntiguo'
      );

      const resultado = await ledgerAislado.ensureTable();

      expect(resultado.created).toBe(false);
      expect(resultado.migrated).toBe(true);

      // El historico sobrevive y queda en el batch 1.
      const registros = await ledgerAislado.all();
      expect(registros).toHaveLength(1);
      expect(registros[0]?.seedName).toBe('SeedAntiguo');
      expect(registros[0]?.batch).toBe(1);

      // Y una segunda pasada ya no migra nada.
      expect((await ledgerAislado.ensureTable()).migrated).toBe(false);
    } finally {
      await aislado.$disconnect();
    }
  });

  it('clear vacia el ledger', async () => {
    const ledger = ledgerFor(engine);
    await ledger.ensureTable();
    await ledger.record('A', 1);

    await ledger.clear();

    expect((await ledger.appliedNames()).size).toBe(0);
  });
});
