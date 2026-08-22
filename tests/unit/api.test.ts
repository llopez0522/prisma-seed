import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rollbackSeeders, runSeeders } from '../../src/api.js';
import { silentLogger } from '../../src/core/logger.js';
import { createMemoryClient, type MemoryClient } from './helpers/memory-client.js';

/**
 * La API programatica de punta a punta.
 *
 * Es la prueba del objetivo de todo el rediseno: `runSeeders(cliente)` funciona
 * igual reciba un cliente con la forma de Prisma o con la de ZenStack v3, los
 * seeders reciben **ese mismo objeto**, y la libreria no lo cierra.
 */

let cwd: string;

interface SeedLogEntry {
  seeder: string;
  hook: 'main' | 'down';
  /** Marca que el seeder deja en el cliente para poder identificarlo. */
  marca: unknown;
  /** Si `client` y `prisma` del contexto son el mismo objeto. */
  aliasCoincide: boolean;
}

declare global {
  var __seedLog: SeedLogEntry[] | undefined;
}

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-')));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
  writeSchema('sqlite');
  globalThis.__seedLog = [];
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  globalThis.__seedLog = undefined;
});

function writeSchema(provider: string): void {
  const dir = path.join(cwd, 'prisma');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'schema.prisma'),
    `datasource db {\n  provider = "${provider}"\n  url = env("DATABASE_URL")\n}\n`
  );
}

/**
 * Escribe un seeder en `prisma/seeders`.
 *
 * Deja constancia en `globalThis` de que cliente recibio, para comprobar desde
 * fuera que es el inyectado y no otro.
 */
function writeSeeder(fileName: string, opts: { falla?: boolean } = {}): void {
  const dir = path.join(cwd, 'prisma', 'seeders');
  fs.mkdirSync(dir, { recursive: true });

  const cuerpo = (hook: 'main' | 'down'): string => `
export async function ${hook}({ prisma, client, name }) {
  globalThis.__seedLog.push({
    seeder: name,
    hook: '${hook}',
    marca: prisma.__marca,
    aliasCoincide: prisma === client,
  });
  ${hook === 'main' && opts.falla === true ? "throw new Error('el seeder reventó');" : ''}
}`;

  fs.writeFileSync(path.join(dir, fileName), `${cuerpo('main')}\n${cuerpo('down')}\n`);
}

function log(): SeedLogEntry[] {
  return globalThis.__seedLog ?? [];
}

function client(surface: 'prisma' | 'alt'): MemoryClient {
  const c = createMemoryClient({ surface });
  return Object.assign(c, { __marca: `marca-${surface}` });
}

const base = { logger: silentLogger } as const;

describe.each(['prisma', 'alt'] as const)(
  'runSeeders con un cliente de superficie %s',
  (surface) => {
    it('ejecuta los seeders de prisma/seeders en orden de timestamp', async () => {
      writeSeeder('20240101000002_Post.mjs');
      writeSeeder('20240101000001_User.mjs');
      const db = client(surface);

      const report = await runSeeders(db, { cwd, ...base });

      expect(report.executed).toEqual(['20240101000001_User', '20240101000002_Post']);
      expect(report.batch).toBe(1);
      expect(db.rows.map((r) => r.seedName)).toEqual([
        '20240101000001_User',
        '20240101000002_Post',
      ]);
    });

    // El nucleo del encargo: el seeder recibe el cliente inyectado, no uno propio.
    it('inyecta el mismo cliente en cada seeder', async () => {
      writeSeeder('20240101000001_User.mjs');
      writeSeeder('20240101000002_Post.mjs');
      const db = client(surface);

      await runSeeders(db, { cwd, ...base });

      const mains = log().filter((e) => e.hook === 'main');
      expect(mains).toHaveLength(2);
      for (const entry of mains) {
        expect(entry.marca).toBe(`marca-${surface}`);
        expect(entry.aliasCoincide).toBe(true);
      }
    });

    it('no cierra el cliente que le prestan', async () => {
      writeSeeder('20240101000001_User.mjs');
      const db = client(surface);

      await runSeeders(db, { cwd, ...base });

      expect(db.disconnected).toBe(0);
    });

    it('no repite lo ya ejecutado y agrupa cada pasada en su batch', async () => {
      writeSeeder('20240101000001_User.mjs');
      const db = client(surface);

      await runSeeders(db, { cwd, ...base });
      const segunda = await runSeeders(db, { cwd, ...base });

      expect(segunda.executed).toEqual([]);
      expect(segunda.skipped).toEqual([{ name: '20240101000001_User', reason: 'ya ejecutado' }]);

      writeSeeder('20240101000002_Post.mjs');
      const tercera = await runSeeders(db, { cwd, ...base });

      expect(tercera.executed).toEqual(['20240101000002_Post']);
      expect(tercera.batch).toBe(2);
    });

    it('--dry-run no toca la base', async () => {
      writeSeeder('20240101000001_User.mjs');
      const db = client(surface);

      const report = await runSeeders(db, { cwd, dryRun: true, ...base });

      expect(report.dryRun).toBe(true);
      expect(report.executed).toEqual([]);
      expect(db.rows).toEqual([]);
      expect(log()).toEqual([]);
    });

    it('only ejecuta un unico seeder, buscando por nombre corto', async () => {
      writeSeeder('20240101000001_User.mjs');
      writeSeeder('20240101000002_Post.mjs');
      const db = client(surface);

      const report = await runSeeders(db, { cwd, only: 'Post', ...base });

      expect(report.executed).toEqual(['20240101000002_Post']);
    });

    it('step limita cuantos pendientes se ejecutan', async () => {
      writeSeeder('20240101000001_User.mjs');
      writeSeeder('20240101000002_Post.mjs');
      const db = client(surface);

      const report = await runSeeders(db, { cwd, step: 1, ...base });

      expect(report.executed).toEqual(['20240101000001_User']);
    });

    // B7: el registro va dentro de la transaccion del propio seeder.
    it('un seeder que falla no queda registrado', async () => {
      writeSeeder('20240101000001_User.mjs', { falla: true });
      const db = client(surface);

      await expect(runSeeders(db, { cwd, ...base })).rejects.toThrow(/reventó/);
      expect(db.rows).toEqual([]);
    });

    it('rollback revierte el ultimo batch y limpia el ledger', async () => {
      writeSeeder('20240101000001_User.mjs');
      const db = client(surface);
      await runSeeders(db, { cwd, ...base });

      const report = await rollbackSeeders(db, { cwd, ...base });

      expect(report.reverted).toEqual(['20240101000001_User']);
      expect(db.rows).toEqual([]);
      expect(log().some((e) => e.hook === 'down')).toBe(true);
      expect(db.disconnected).toBe(0);
    });

    it('avisa en vez de fallar si nunca se creo la tabla del ledger', async () => {
      const db = client(surface);

      const report = await rollbackSeeders(db, { cwd, ...base });

      expect(report.reverted).toEqual([]);
    });
  }
);

/**
 * La libreria no bifurca por cliente: envia el mismo objeto de opciones a los dos
 * y cada uno aplica lo que entiende.
 */
describe('opciones de transaccion', () => {
  it.each(['prisma', 'alt'] as const)('a un cliente %s le pasa las mismas opciones', async (s) => {
    writeSeeder('20240101000001_User.mjs');
    const db = client(s);

    await runSeeders(db, { cwd, config: { transactionTimeout: 9999 }, ...base });

    expect(db.transactionOptions).toEqual([{ timeout: 9999 }]);
  });

  it('con transactional:false no se abre ninguna transaccion', async () => {
    writeSeeder('20240101000001_User.mjs');
    const db = client('alt');

    await runSeeders(db, { cwd, config: { transactional: false }, ...base });

    expect(db.transactionOptions).toEqual([]);
    expect(db.rows).toHaveLength(1);
  });
});

describe('configuracion y descubrimiento', () => {
  it('respeta un seedersDir distinto', async () => {
    const dir = path.join(cwd, 'db', 'seeds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20240101000001_User.mjs'), 'export async function main() {}');
    const db = client('prisma');

    const report = await runSeeders(db, { cwd, config: { seedersDir: 'db/seeds' }, ...base });

    expect(report.executed).toEqual(['20240101000001_User']);
  });

  // Sin schema.prisma no hay como deducir el motor: `provider` lo resuelve.
  it('acepta el provider explicito y no lee el schema', async () => {
    fs.rmSync(path.join(cwd, 'prisma', 'schema.prisma'));
    writeSeeder('20240101000001_User.mjs');
    const db = client('alt');

    const report = await runSeeders(db, { cwd, config: { provider: 'sqlite' }, ...base });

    expect(report.executed).toEqual(['20240101000001_User']);
  });

  // El caso ZenStack v3 sin configurar nada: schema en zenstack/schema.zmodel.
  it('deduce el motor de un zenstack/schema.zmodel con comillas simples', async () => {
    fs.rmSync(path.join(cwd, 'prisma', 'schema.prisma'));
    fs.mkdirSync(path.join(cwd, 'zenstack'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'zenstack', 'schema.zmodel'),
      `datasource db {\n  provider = 'sqlite'\n  url = env('DATABASE_URL')\n}\n`
    );
    writeSeeder('20240101000001_User.mjs');
    const db = client('alt');

    const report = await runSeeders(db, { cwd, ...base });

    expect(report.executed).toEqual(['20240101000001_User']);
  });

  it('avisa si no hay ningun seeder', async () => {
    const db = client('prisma');

    const report = await runSeeders(db, { cwd, ...base });

    expect(report.executed).toEqual([]);
  });
});

describe('migracion del ledger de la v0.2.4', () => {
  it('anade la columna batch y deja el historico en el batch 1', async () => {
    const db = createMemoryClient({ surface: 'prisma', legacyTable: true });
    db.rows.push({ id: 1, seedName: 'Antiguo', batch: 0, executedAt: new Date() });

    writeSeeder('20240101000001_User.mjs');
    await runSeeders(db, { cwd, ...base });

    expect(db.hasBatchColumn).toBe(true);
    expect(db.rows.find((r) => r.seedName === 'Antiguo')?.batch).toBe(1);
  });
});
