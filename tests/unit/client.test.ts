import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSeedClient,
  capabilitiesOf,
  connectClient,
  disconnectClient,
  resolveSeedClient,
  runInTransaction,
  supportsTransactions,
} from '../../src/core/client.js';
import { ConnectionError } from '../../src/core/errors.js';
import { resetPrismaForTests } from '../../src/core/prisma.js';
import { silentLogger } from '../../src/core/logger.js';
import { fakeAltClient, fakeMinimalClient, fakePrismaClient } from './helpers/fake-clients.js';
import type { SeedClient } from '../../src/types.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'client-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  resetPrismaForTests();
});

describe('capabilitiesOf', () => {
  it('declara lo que sabe hacer cada cliente', () => {
    expect(capabilitiesOf(fakePrismaClient())).toEqual({
      transactions: true,
      connect: true,
      disconnect: true,
    });
    expect(capabilitiesOf(fakeAltClient())).toEqual({
      transactions: true,
      connect: true,
      disconnect: true,
    });
  });

  // Lo importante: se mira la capacidad, no de quien es el cliente. Un cliente
  // minimo — solo SQL crudo — es valido y se describe como tal.
  it('un cliente minimo declara que no puede transaccionar ni cerrar', () => {
    expect(capabilitiesOf(fakeMinimalClient())).toEqual({
      transactions: false,
      connect: false,
      disconnect: false,
    });
  });
});

describe('assertSeedClient', () => {
  it('acepta cualquier cliente con las dos operaciones de SQL crudo', () => {
    expect(() => {
      assertSeedClient(fakeAltClient(), 'la prueba');
    }).not.toThrow();
  });

  it('rechaza lo que no es un objeto', () => {
    expect(() => {
      assertSeedClient(42, 'la prueba');
    }).toThrow(ConnectionError);
    expect(() => {
      assertSeedClient(null, 'la prueba');
    }).toThrow(ConnectionError);
  });

  it('dice exactamente que operacion falta', () => {
    expect(() => {
      assertSeedClient({ $queryRawUnsafe: () => Promise.resolve([]) }, 'la prueba');
    }).toThrow(/\$executeRawUnsafe/);
  });

  // El fallo tipico: un ORM con politicas de acceso bloquea el SQL crudo.
  it('la pista apunta al control de acceso, que es la causa habitual', () => {
    try {
      assertSeedClient({}, 'la prueba');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect((error as ConnectionError).hint).toMatch(/politicas de acceso/i);
    }
  });
});

describe('supportsTransactions', () => {
  it('distingue clientes con y sin $transaction', () => {
    expect(supportsTransactions(fakePrismaClient())).toBe(true);
    expect(supportsTransactions(fakeMinimalClient())).toBe(false);
  });
});

describe('runInTransaction', () => {
  const noop = async (): Promise<void> => {};

  /**
   * El punto de la abstraccion: se envia SIEMPRE el mismo objeto de opciones y
   * cada cliente aplica lo que entiende. Comprobado contra un ZenStackClient
   * real, que lee `isolationLevel` e ignora el resto sin protestar.
   */
  it.each([
    ['tipo Prisma', fakePrismaClient],
    ['otra implementacion del contrato', fakeAltClient],
  ])('a un cliente %s le pasa las opciones sin bifurcar', async (_n, crear) => {
    const client = crear();

    await runInTransaction(client, noop, { timeout: 1234 });

    expect(client.transactionCalls).toHaveLength(1);
    expect(client.transactionCalls[0]?.options).toEqual({ timeout: 1234 });
  });

  it('inyecta el cliente de la transaccion en el callback', async () => {
    const client = fakePrismaClient();
    let recibido: SeedClient | null = null;

    await runInTransaction(
      client,
      (tx) => {
        recibido = tx;
        return Promise.resolve();
      },
      { timeout: 1 }
    );

    expect(recibido).toBe(client);
  });

  it('propaga el error del callback', async () => {
    const client = fakePrismaClient();

    await expect(
      runInTransaction(client, () => Promise.reject(new Error('el seeder fallo')), { timeout: 1 })
    ).rejects.toThrow('el seeder fallo');
  });

  it('lanza con una pista accionable si el cliente no puede transaccionar', async () => {
    const client = fakeMinimalClient();

    await expect(runInTransaction(client, noop, { timeout: 1 })).rejects.toThrow(ConnectionError);
    await expect(runInTransaction(client, noop, { timeout: 1 })).rejects.toThrow(/\$transaction/);
  });
});

describe('connectClient', () => {
  it('llama a $connect cuando existe', async () => {
    const client = fakePrismaClient();
    await connectClient(client);
    expect(client.connected).toBe(1);
  });

  it('no falla si el cliente no puede conectar explicitamente', async () => {
    await expect(connectClient(fakeMinimalClient())).resolves.toBeUndefined();
  });
});

describe('disconnectClient', () => {
  it('llama a $disconnect cuando existe', async () => {
    const client = fakePrismaClient();
    await disconnectClient(client);
    expect(client.disconnected).toBe(1);
  });

  it('no falla si el cliente no expone $disconnect', async () => {
    await expect(disconnectClient(fakeMinimalClient())).resolves.toBeUndefined();
  });
});

describe('resolveSeedClient', () => {
  it('el cliente inyectado gana sobre todo lo demas', async () => {
    const inyectado = fakeAltClient();
    const configurado = fakePrismaClient();

    const resuelto = await resolveSeedClient({
      cwd,
      injected: inyectado,
      source: configurado,
      logger: silentLogger,
    });

    expect(resuelto.client).toBe(inyectado);
    expect(resuelto.origin).toBe('injected');
    expect(resuelto.capabilities.transactions).toBe(true);
    expect(resuelto.createdByLibrary).toBe(false);
  });

  it('acepta un cliente literal en la configuracion', async () => {
    const client = fakeAltClient();

    const resuelto = await resolveSeedClient({ cwd, source: client, logger: silentLogger });

    expect(resuelto.client).toBe(client);
    expect(resuelto.origin).toBe('config');
    expect(resuelto.createdByLibrary).toBe(false);
  });

  it('acepta una fabrica sincrona', async () => {
    const client = fakeAltClient();

    const resuelto = await resolveSeedClient({ cwd, source: () => client, logger: silentLogger });

    expect(resuelto.client).toBe(client);
  });

  it('acepta una fabrica asincrona', async () => {
    const client = fakeAltClient();

    const resuelto = await resolveSeedClient({
      cwd,
      source: () => Promise.resolve(client),
      logger: silentLogger,
    });

    expect(resuelto.client).toBe(client);
  });

  it('la fabrica se invoca una sola vez por resolucion', async () => {
    let veces = 0;
    const client = fakeAltClient();

    await resolveSeedClient({
      cwd,
      source: () => {
        veces += 1;
        return client;
      },
      logger: silentLogger,
    });

    expect(veces).toBe(1);
  });

  it('explica el fallo si la fabrica lanza', async () => {
    await expect(
      resolveSeedClient({
        cwd,
        source: () => {
          throw new Error('falta DATABASE_URL');
        },
        logger: silentLogger,
      })
    ).rejects.toThrow(/falta DATABASE_URL/);
  });

  it('rechaza una fabrica que devuelve algo que no es un cliente', async () => {
    await expect(
      resolveSeedClient({
        cwd,
        source: () => ({}) as never,
        logger: silentLogger,
      })
    ).rejects.toThrow(ConnectionError);
  });

  // Sin `client` en la configuracion se cae al camino de siempre: resolver
  // @prisma/client desde el proyecto. En un directorio vacio, eso falla claro.
  it('sin configuracion intenta @prisma/client y falla con ConnectionError', async () => {
    await expect(resolveSeedClient({ cwd, logger: silentLogger })).rejects.toThrow(ConnectionError);
  });
});
