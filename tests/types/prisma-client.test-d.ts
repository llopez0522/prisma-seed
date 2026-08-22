import type { PrismaClient } from '@prisma/client';

import type { SeedClient, SeedTransactionOptions } from '../../src/types.js';

/**
 * Comprobaciones de TIPOS, no de runtime.
 *
 * No las ejecuta vitest (su patron es `*.test.ts`): las verifica `npm run
 * typecheck`. Si `SeedClient` deja de admitir un cliente real, este archivo deja
 * de compilar, que es exactamente cuando hay que enterarse.
 *
 * **No lo cubre `npm run typecheck`**, y es a proposito: en la raiz del
 * repositorio `@prisma/client` no tiene cliente generado, asi que `PrismaClient`
 * degrada a `any` y la comprobacion seria falsa (lo demostro el propio `Assert`
 * de abajo al escribirla). Se compila contra el cliente REAL del fixture
 * `.fixtures/pg-cjs` con su propio tsconfig: `tests/types/run.sh`.
 *
 * La mitad de ZenStack v3 esta en `zenstack-client.test-d.ts` y se compila
 * dentro del proyecto consumidor, que es el unico sitio donde `@zenstackhq/orm`
 * existe. La ejecuta `tests/integration/zenstack-v3/run.sh`.
 */

/** Falla la compilacion si `T` no es exactamente `true`. */
type Assert<T extends true> = T;

declare const prisma: PrismaClient;

// 1. Un PrismaClient real es un SeedClient. Sin cast.
export const prismaEsSeedClient: SeedClient = prisma;

// 2. Y lo es de forma estructural, no por `any`: si `PrismaClient` degradara a
//    `any`, la condicional daria `boolean` y `Assert` no compilaria.
export type PrismaNoEsAny = Assert<PrismaClient extends SeedClient ? true : false>;

export async function contratos(): Promise<void> {
  // 3. El `tx` que entrega Prisma encaja en el callback de `SeedClient`.
  await prisma.$transaction(async (tx) => {
    const t: SeedClient = tx;
    await t.$queryRawUnsafe<{ n: number }[]>('SELECT 1 AS n');
    await t.$executeRawUnsafe('SELECT 1');
  });

  // 4. Como llama la libreria: NUNCA al cliente concreto, sino a traves de
  //    `SeedClient`. Ese es el punto donde encaja el objeto que construye
  //    `transactionOptionsFor()`.
  const comoLaLibreria: SeedClient = prisma;
  const opciones: SeedTransactionOptions = { timeout: 300_000 };
  if (typeof comoLaLibreria.$transaction === 'function') {
    await comoLaLibreria.$transaction(async () => {}, opciones);
  }

  // 5. La asimetria que justifica filtrar por sabor: la firma NATIVA de Prisma
  //    acepta `timeout` y `maxWait`...
  await prisma.$transaction(async () => {}, { timeout: 300_000, maxWait: 2_000 });
  //    ...y la de ZenStack 3.9.1 los rechaza. Ver `zenstack-client.test-d.ts`.
}

// 6. El cliente minimo — solo SQL crudo — tambien es un SeedClient valido.
export const minimo: SeedClient = {
  $queryRawUnsafe: <T>(): Promise<T> => Promise.resolve([] as unknown as T),
  $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),
};
