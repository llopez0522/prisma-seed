import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  capabilitiesOf,
  rollbackSeeders,
  runSeeders,
  silentLogger,
  type SeedClient,
  type SeedTransactionOptions,
} from 'prisma-seed';

/**
 * La libreria contra el cliente REAL de un proyecto externo.
 *
 * Es la contraparte de `tests/integration/injection.test.ts`, que usa dobles: aqui
 * el cliente lo construye el proyecto consumidor con su propio ORM, y la libreria
 * solo sabe que cumple el contrato.
 *
 * **No corre en la suite normal.** Necesita un proyecto externo, sus
 * `node_modules` y una base de datos, asi que se salta salvo que el entorno este
 * montado. Como montarlo: `README.md` de esta carpeta, y `run.sh` lo hace entero.
 *
 * | Variable | Que es |
 * |---|---|
 * | `SEED_REAL_PROJECT_DIR` | raiz del proyecto consumidor |
 * | `SEED_REAL_CLIENT_MODULE` | modulo que exporta el cliente como `db` |
 * | `DATABASE_URL` | una base **de usar y tirar** |
 *
 * Nada de aqui conoce el proyecto: los seeders usan solo SQL crudo sobre una
 * tabla propia, asi que sirve para cualquier consumidor.
 */

const projectDir = process.env['SEED_REAL_PROJECT_DIR'];
const clientModule = process.env['SEED_REAL_CLIENT_MODULE'];
const activo = projectDir !== undefined && clientModule !== undefined;

const LEDGER = 'PscSeedExecution';
const TABLA = 'psc_seed_probe';

/** Carga el modulo del cliente sin dejar entrar un `any`. */
async function importarCliente(ruta: string): Promise<SeedClient> {
  const cargado: unknown = await import(/* @vite-ignore */ ruta);

  if (typeof cargado !== 'object' || cargado === null || !('db' in cargado)) {
    throw new Error(`${ruta} no exporta "db".`);
  }

  const candidato: unknown = cargado.db;
  if (
    typeof candidato !== 'object' ||
    candidato === null ||
    typeof (candidato as Partial<SeedClient>).$queryRawUnsafe !== 'function' ||
    typeof (candidato as Partial<SeedClient>).$executeRawUnsafe !== 'function'
  ) {
    throw new Error(`"db" de ${ruta} no cumple el contrato SeedClient.`);
  }

  return candidato as SeedClient;
}

/**
 * Envuelve el cliente real para anotar con que opciones se llama a
 * `$transaction`, sin sustituir su implementacion.
 */
function observarTransacciones(real: SeedClient): {
  client: SeedClient;
  opciones: (SeedTransactionOptions | undefined)[];
} {
  const opciones: (SeedTransactionOptions | undefined)[] = [];

  const client = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);

      return <R>(fn: (tx: SeedClient) => Promise<R>, opts?: SeedTransactionOptions): Promise<R> => {
        opciones.push(opts);
        if (typeof target.$transaction !== 'function') {
          throw new Error('el cliente real no expone $transaction');
        }
        return opts === undefined ? target.$transaction(fn) : target.$transaction(fn, opts);
      };
    },
  });

  return { client, opciones };
}

describe.skipIf(!activo)('cliente real de un proyecto externo', () => {
  let db: SeedClient;
  const cwd = projectDir ?? '';
  /**
   * `seedersDir` va EXPLICITO, no por defecto.
   *
   * El proyecto consumidor puede tener su propio `seeder.config`, y esa
   * configuracion gana sobre el valor por defecto de la libreria — asi debe ser.
   * Sin fijarlo aqui, el test acabaria cargando los seeders del proyecto en vez
   * de sus fixtures, que es justo el acoplamiento que este harness evita.
   */
  const base = {
    cwd,
    logger: silentLogger,
    config: { ledgerTable: LEDGER, seedersDir: 'prisma/seeders' },
  } as const;

  beforeAll(async () => {
    db = await importarCliente(clientModule ?? '');
    await db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${TABLA}" ("clave" VARCHAR(50) PRIMARY KEY, "valor" VARCHAR(50))`
    );
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${LEDGER}"`);
    await db.$executeRawUnsafe(`DELETE FROM "${TABLA}"`);
  });

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${LEDGER}"`);
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLA}"`);
    // No se llama a $disconnect(): el cliente es del proyecto consumidor.
  });

  async function sondas(): Promise<Record<string, string>> {
    const filas = await db.$queryRawUnsafe<{ clave: string; valor: string }[]>(
      `SELECT "clave", "valor" FROM "${TABLA}" ORDER BY "clave"`
    );
    return Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
  }

  it('el cliente real cumple el contrato completo', () => {
    expect(capabilitiesOf(db)).toEqual({ transactions: true, connect: true, disconnect: true });
  });

  it('ejecuta los seeders contra la base real', async () => {
    const report = await runSeeders(db, base);

    expect(report.executed).toEqual(['20260101000001_Contrato', '20260101000002_Segundo']);
    expect(report.batch).toBe(1);
    expect(await sondas()).toEqual({ contrato: 'alias-ok', segundo: 'ok' });
  });

  it('los seeders reciben el cliente inyectado, no otro', async () => {
    await runSeeders(db, base);
    // El seeder solo escribe 'alias-ok' si ctx.prisma === ctx.client.
    expect((await sondas())['contrato']).toBe('alias-ok');
  });

  it('el ledger vive en la base real y evita repetir', async () => {
    await runSeeders(db, base);

    const filas = await db.$queryRawUnsafe<{ seedName: string; batch: number }[]>(
      `SELECT "seedName", "batch" FROM "${LEDGER}" ORDER BY "id"`
    );
    expect(filas).toHaveLength(2);

    const segunda = await runSeeders(db, base);
    expect(segunda.executed).toEqual([]);
    expect(segunda.skipped).toHaveLength(2);
  });

  it('recibe las opciones de transaccion tal cual, sin bifurcar por cliente', async () => {
    const { client, opciones } = observarTransacciones(db);

    await runSeeders(client, { ...base, config: { ...base.config, transactionTimeout: 12_345 } });

    expect(opciones).toEqual([{ timeout: 12_345 }, { timeout: 12_345 }]);
  });

  it('la transaccion real revierte el seeder y su registro si algo falla', async () => {
    await expect(
      runSeeders(db, { ...base, config: { ...base.config, seedersDir: 'prisma/seeders-fallo' } })
    ).rejects.toThrow(/a proposito/);

    expect(await sondas()).toEqual({});

    const registrado = await db.$queryRawUnsafe<{ seedName: string }[]>(
      `SELECT "seedName" FROM "${LEDGER}"`
    );
    expect(registrado).toEqual([]);
  });

  it('rollback revierte contra la base real', async () => {
    await runSeeders(db, base);

    const report = await rollbackSeeders(db, { ...base, all: true });

    expect(report.reverted).toEqual(['20260101000002_Segundo', '20260101000001_Contrato']);
    expect(await sondas()).toEqual({});
  });

  /**
   * El cliente pertenece a la aplicacion consumidora. Si la libreria lo cerrara,
   * el siguiente uso fallaria con "Cannot use a pool after calling end".
   */
  it('deja el cliente utilizable: no cierra lo que no ha creado', async () => {
    await runSeeders(db, base);
    await rollbackSeeders(db, { ...base, all: true });

    const vivo = await db.$queryRawUnsafe<{ n: number }[]>('SELECT 1 AS n');
    expect(Number(vivo[0]?.n)).toBe(1);
  });

  // Sin `cwd`: la raiz se busca subiendo desde el directorio de trabajo.
  it('encuentra la raiz del proyecto sin que se la digan', async () => {
    const report = await runSeeders(db, {
      logger: silentLogger,
      config: { ledgerTable: LEDGER, seedersDir: 'prisma/seeders' },
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.executed).toEqual([]);
  });
});
