import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rollbackSeeders, runSeeders } from '../../src/api.js';
import { getDialect } from '../../src/core/dialect/index.js';
import { silentLogger } from '../../src/core/logger.js';
import { clientFor, ENGINES, type Engine, type TestPrismaClient } from './helpers/clients.js';
import { contractClient, type ContractClient } from './helpers/contract-client.js';
import type { SeedClient } from '../../src/types.js';

/**
 * Inyeccion de cliente contra bases de datos reales.
 *
 * Cada motor se ejercita dos veces: con el `PrismaClient` de verdad y con una
 * segunda implementacion del contrato que no es Prisma
 * (`helpers/contract-client.ts`). El codigo de los seeders y el de la libreria es
 * **el mismo** en los dos casos, que es justo lo que hay que demostrar.
 */

const LEDGER = 'SeedExecutionInject';
const SCRATCH = 'SeedScratch';

const clients = new Map<Engine, TestPrismaClient>();

function prismaFor(engine: Engine): TestPrismaClient {
  let c = clients.get(engine);
  if (!c) {
    c = clientFor(engine);
    clients.set(engine, c);
  }
  return c;
}

afterAll(async () => {
  for (const c of clients.values()) await c.$disconnect();
});

let cwd: string;

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inject-')));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  globalThis.__injectLog = undefined;
});

interface InjectLogEntry {
  name: string;
  hook: string;
  mismoCliente: boolean;
}

declare global {
  var __injectLog: InjectLogEntry[] | undefined;
}

/**
 * Escribe un seeder que inserta en una tabla real y deja constancia de si el
 * cliente que recibio es el que se inyecto.
 */
function writeSeeder(fileName: string, opts: { falla?: boolean } = {}): void {
  const dir = path.join(cwd, 'prisma', 'seeders');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, fileName),
    `export async function main({ prisma, client, name }) {
  globalThis.__injectLog.push({ name, hook: 'main', mismoCliente: prisma === client });
  await prisma.$executeRawUnsafe(globalThis.__insertSql, name);
  ${opts.falla === true ? "throw new Error('el seeder reventó');" : ''}
}

export async function down({ prisma, client, name }) {
  globalThis.__injectLog.push({ name, hook: 'down', mismoCliente: prisma === client });
  await prisma.$executeRawUnsafe(globalThis.__deleteSql, name);
}
`
  );
}

function writeSchema(engine: Engine): void {
  const dir = path.join(cwd, 'prisma');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'schema.prisma'),
    `datasource db {\n  provider = "${engine}"\n  url = env("DATABASE_URL")\n}\n`
  );
}

async function resetTables(engine: Engine): Promise<void> {
  const dialect = getDialect(engine);
  const prisma = prismaFor(engine);

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${dialect.quote(LEDGER)}`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${dialect.quote(SCRATCH)}`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE ${dialect.quote(SCRATCH)} (${dialect.quote('seedName')} VARCHAR(255) NOT NULL)`
  );

  globalThis.__insertSql = `INSERT INTO ${dialect.quote(SCRATCH)} (${dialect.quote('seedName')}) VALUES (${dialect.placeholder(1)})`;
  globalThis.__deleteSql = `DELETE FROM ${dialect.quote(SCRATCH)} WHERE ${dialect.quote('seedName')} = ${dialect.placeholder(1)}`;
  globalThis.__injectLog = [];
}

declare global {
  var __insertSql: string | undefined;
  var __deleteSql: string | undefined;
}

async function scratchRows(engine: Engine): Promise<string[]> {
  const dialect = getDialect(engine);
  const rows = await prismaFor(engine).$queryRawUnsafe<{ seedName: string }[]>(
    `SELECT ${dialect.quote('seedName')} FROM ${dialect.quote(SCRATCH)}`
  );
  return rows.map((r) => r.seedName);
}

/** Las dos implementaciones que se prueban, sobre la misma conexion real. */
const CLIENTES = ['prisma', 'contrato'] as const;

function clientOf(engine: Engine, cual: (typeof CLIENTES)[number]): SeedClient {
  return cual === 'prisma' ? prismaFor(engine) : contractClient(prismaFor(engine), engine);
}

describe.each(ENGINES)('inyeccion de cliente sobre %s', (engine) => {
  describe.each(CLIENTES)('con un cliente %s', (cual) => {
    const base = {
      logger: silentLogger,
      config: { ledgerTable: LEDGER, provider: engine },
    } as const;

    beforeEach(async () => {
      writeSchema(engine);
      await resetTables(engine);
    });

    it('crea el ledger, ejecuta los seeders y escribe en la base real', async () => {
      writeSeeder('20240101000001_Uno.mjs');
      writeSeeder('20240101000002_Dos.mjs');
      const db = clientOf(engine, cual);

      const report = await runSeeders(db, { cwd, ...base });

      expect(report.executed).toEqual(['20240101000001_Uno', '20240101000002_Dos']);
      expect(await scratchRows(engine)).toEqual(['20240101000001_Uno', '20240101000002_Dos']);
      expect(globalThis.__injectLog?.every((e) => e.mismoCliente)).toBe(true);
    });

    it('no vuelve a ejecutar lo ya registrado', async () => {
      writeSeeder('20240101000001_Uno.mjs');
      const db = clientOf(engine, cual);

      await runSeeders(db, { cwd, ...base });
      const segunda = await runSeeders(db, { cwd, ...base });

      expect(segunda.executed).toEqual([]);
      expect(await scratchRows(engine)).toEqual(['20240101000001_Uno']);
    });

    // B7 contra una base real: el registro y el seeder son atomicos.
    it('un seeder que falla no deja rastro ni en la tabla ni en el ledger', async () => {
      writeSeeder('20240101000001_Uno.mjs', { falla: true });
      const db = clientOf(engine, cual);

      await expect(runSeeders(db, { cwd, ...base })).rejects.toThrow(/reventó/);

      expect(await scratchRows(engine)).toEqual([]);
      const segunda = await runSeeders(db, { cwd, ...base, only: 'Uno' }).catch(() => null);
      expect(segunda).toBeNull();
    });

    it('rollback revierte y limpia el ledger', async () => {
      writeSeeder('20240101000001_Uno.mjs');
      const db = clientOf(engine, cual);
      await runSeeders(db, { cwd, ...base });

      const report = await rollbackSeeders(db, { cwd, ...base });

      expect(report.reverted).toEqual(['20240101000001_Uno']);
      expect(await scratchRows(engine)).toEqual([]);
    });

    // La libreria no cierra lo que no ha creado: el cliente sigue usable.
    it('deja el cliente abierto al terminar', async () => {
      writeSeeder('20240101000001_Uno.mjs');
      const db = clientOf(engine, cual);

      await runSeeders(db, { cwd, ...base });

      await expect(db.$queryRawUnsafe('SELECT 1')).resolves.toBeDefined();
    });
  });

  /**
   * La libreria envia el mismo objeto de opciones sea cual sea el cliente: no
   * bifurca por implementacion. El que no soporte una opcion la ignora.
   */
  it('manda las mismas opciones de transaccion a cualquier cliente', async () => {
    writeSchema(engine);
    await resetTables(engine);
    writeSeeder('20240101000001_Uno.mjs');

    const db: ContractClient = contractClient(prismaFor(engine), engine);

    await runSeeders(db, {
      cwd,
      logger: silentLogger,
      config: { ledgerTable: LEDGER, provider: engine, transactionTimeout: 12_345 },
    });

    expect(db.transactionOptions).toEqual([{ timeout: 12_345 }]);
  });

  /**
   * La tabla ausente tiene que reconocerse tambien cuando el error NO lleva la
   * envoltura de Prisma, sino `reason` + `dbErrorCode`/`dbErrorMessage`.
   */
  it('detecta la tabla ausente a traves de un error con forma de ORMError', async () => {
    writeSchema(engine);
    await resetTables(engine);
    writeSeeder('20240101000001_Uno.mjs');

    const db = contractClient(prismaFor(engine), engine);
    const dialect = getDialect(engine);
    await prismaFor(engine).$executeRawUnsafe(`DROP TABLE IF EXISTS ${dialect.quote(LEDGER)}`);

    const report = await runSeeders(db, {
      cwd,
      logger: silentLogger,
      config: { ledgerTable: LEDGER, provider: engine },
    });

    expect(report.executed).toEqual(['20240101000001_Uno']);
  });
});
