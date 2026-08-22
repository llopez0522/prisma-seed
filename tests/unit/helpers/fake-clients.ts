import type { SeedClient, SeedTransactionOptions } from '../../../src/types.js';

/**
 * Dobles de cliente para las pruebas de unidad.
 *
 * Existen tres porque la libreria razona sobre CAPACIDADES, y hay tres casos que
 * cubrir: el cliente completo con la superficie de Prisma, otra implementacion
 * completa que no es Prisma (su forma esta tomada de `ZenStackClient` 3.9.1), y
 * el minimo que solo cumple lo obligatorio.
 *
 * Ninguno de los tres se distingue por su marca en el codigo de la libreria: se
 * distinguen por lo que saben hacer.
 */

export interface TransactionCall {
  options: SeedTransactionOptions | undefined;
}

export interface FakeClient extends SeedClient {
  transactionCalls: TransactionCall[];
  disconnected: number;
  connected: number;
}

function withCapabilities(): FakeClient {
  const client: FakeClient = {
    transactionCalls: [],
    disconnected: 0,
    connected: 0,

    $queryRawUnsafe: <T>(): Promise<T> => Promise.resolve([] as unknown as T),
    $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),

    $connect: (): Promise<void> => {
      client.connected += 1;
      return Promise.resolve();
    },

    $disconnect: (): Promise<void> => {
      client.disconnected += 1;
      return Promise.resolve();
    },

    $transaction: <R>(
      fn: (tx: SeedClient) => Promise<R>,
      options?: SeedTransactionOptions
    ): Promise<R> => {
      client.transactionCalls.push({ options });
      return fn(client);
    },
  };

  return client;
}

/** Cliente con la superficie de `PrismaClient`. */
export function fakePrismaClient(): FakeClient {
  const client = withCapabilities();
  return Object.assign(client, { $extends: () => client, $on: () => undefined });
}

/**
 * Otra implementacion completa del contrato, con superficie distinta de Prisma.
 *
 * La forma esta tomada de `ZenStackClient` 3.9.1 (`$qb`, `$schema`, `$setAuth`),
 * pero para la libreria es simplemente "un cliente que cumple el contrato".
 */
export function fakeAltClient(): FakeClient {
  const client = withCapabilities();
  return Object.assign(client, {
    $qb: {},
    $schema: { provider: 'sqlite' },
    $setAuth: () => client,
    $use: () => client,
  });
}

/**
 * El minimo que acepta el contrato: solo SQL crudo.
 *
 * Es tambien la forma del cliente que ambos ORMs entregan DENTRO de una
 * transaccion, que no tiene `$transaction` ni `$connect` ni `$disconnect`.
 */
export function fakeMinimalClient(): FakeClient {
  return {
    transactionCalls: [],
    disconnected: 0,
    connected: 0,
    $queryRawUnsafe: <T>(): Promise<T> => Promise.resolve([] as unknown as T),
    $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),
  };
}
