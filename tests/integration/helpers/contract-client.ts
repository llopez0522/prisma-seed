import type { SeedClient, SeedTransactionOptions } from '../../../src/types.js';
import type { TestPrismaClient } from './clients.js';

/**
 * Segunda implementacion del contrato, respaldada por una base de datos real.
 *
 * Sirve para comprobar que la libreria **no depende de que el cliente sea
 * Prisma**: este no lo es. Su superficie y sus errores estan modelados sobre
 * `@zenstackhq/orm@3.9.1`, que es el otro cliente verificado, pero para la
 * libreria es simplemente "un objeto que cumple `SeedClient`".
 *
 * Que cambia respecto de Prisma:
 *
 *  - No expone `$extends` ni `$on`.
 *  - Expone `$qb`, `$schema` y `$setAuth`.
 *  - Sus errores no llevan `meta`: llevan `reason`, `dbErrorCode` y
 *    `dbErrorMessage`. Se **elimina** la envoltura de Prisma antes de relanzar,
 *    para que la deteccion de "tabla ausente" no pueda aprobar por el camino
 *    equivocado.
 *  - Su `$transaction` acepta opciones pero solo aplica `isolationLevel`, e
 *    **ignora** el resto — igual que hace el cliente real, comprobado en
 *    ejecucion.
 *
 * Corre en la suite normal, en los tres motores. La comprobacion contra el
 * paquete de verdad esta en `tests/integration/zenstack-v3/`.
 */

export interface ContractClient extends SeedClient {
  /** Opciones recibidas en cada llamada a `$transaction`. */
  transactionOptions: (SeedTransactionOptions | undefined)[];
  disconnected: number;
  $qb: unknown;
  $schema: { provider: string };
}

/** Convierte un error de Prisma en uno con la forma de `ORMError`. */
function toOrmError(error: unknown): Error {
  const source = error as { meta?: { code?: unknown; message?: unknown }; message?: string };
  const code = source.meta?.code;

  const orm = new Error(source.message ?? 'ORM error');
  return Object.assign(orm, {
    reason: 'db-query-error',
    ...(typeof code === 'string' || typeof code === 'number' ? { dbErrorCode: String(code) } : {}),
    ...(typeof source.meta?.message === 'string' ? { dbErrorMessage: source.meta.message } : {}),
  });
}

/** Miembros que este cliente NO tiene, a diferencia de Prisma. */
const PRISMA_ONLY = new Set(['$extends', '$on']);

export function contractClient(inner: TestPrismaClient, provider: string): ContractClient {
  const facade: ContractClient = {
    transactionOptions: [],
    disconnected: 0,
    $qb: {},
    $schema: { provider },

    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]): Promise<T> => {
      try {
        return await inner.$queryRawUnsafe<T>(query, ...values);
      } catch (error) {
        throw toOrmError(error);
      }
    },

    $executeRawUnsafe: async (query: string, ...values: unknown[]): Promise<number> => {
      try {
        return await inner.$executeRawUnsafe(query, ...values);
      } catch (error) {
        throw toOrmError(error);
      }
    },

    $connect: () => inner.$connect(),

    $disconnect: async (): Promise<void> => {
      facade.disconnected += 1;
      await inner.$disconnect();
    },

    $transaction: <R>(
      fn: (tx: SeedClient) => Promise<R>,
      options?: SeedTransactionOptions
    ): Promise<R> => {
      facade.transactionOptions.push(options);

      // Aplica solo lo que entiende e IGNORA el resto, que es lo que hace el
      // cliente real. Si la libreria volviera a bifurcar por implementacion,
      // este doble no lo notaria — y precisamente por eso no debe bifurcar.

      // El `tx` que ve el seeder tambien tiene que ser de la misma familia.
      return inner.$transaction((tx) => fn(txFacade(tx)));
    },
  };

  const $setAuth = (): ContractClient => proxied;

  /** Reenvia los delegados de modelo (`db.user.create`) al cliente real. */
  const proxied = new Proxy(Object.assign(facade, { $setAuth }), {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && PRISMA_ONLY.has(prop)) return undefined;
      if (prop in target) return Reflect.get(target, prop, receiver);

      const value: unknown = Reflect.get(inner, prop);
      return typeof value === 'function' ? (value as () => unknown).bind(inner) : value;
    },
    has(target, prop): boolean {
      if (typeof prop === 'string' && PRISMA_ONLY.has(prop)) return false;
      return prop in target || prop in inner;
    },
  }) as ContractClient;

  return proxied;
}

/** Misma envoltura para el cliente de transaccion que reciben los seeders. */
function txFacade(tx: SeedClient): SeedClient {
  return new Proxy(tx, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && PRISMA_ONLY.has(prop)) return undefined;
      if (prop === '$qb') return {};
      return Reflect.get(target, prop, receiver);
    },
  });
}
