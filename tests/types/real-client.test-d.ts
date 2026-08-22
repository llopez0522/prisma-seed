/**
 * Comprobacion de TIPOS contra el cliente real de un proyecto externo.
 *
 * Se compila **dentro del proyecto consumidor**, que es el unico sitio donde su
 * ORM esta instalado. Lo ejecuta `tests/integration/real-client/run.sh`, que
 * escribe un tsconfig con estos dos mapeos:
 *
 *   prisma-seed -> el `dist` compilado de esta libreria
 *   @seed-real-client    -> el modulo del proyecto que exporta `db`
 *
 * Asi el archivo no menciona ninguna ruta concreta y sirve para cualquier
 * proyecto. La contraparte de Prisma esta en `prisma-client.test-d.ts`.
 */
import type { SeedClient } from 'prisma-seed';
import { runSeeders } from 'prisma-seed';

import { db } from '@seed-real-client';

/** Falla la compilacion si `T` no es exactamente `true`. */
type Assert<T extends true> = T;

// 1. El cliente real del proyecto es un SeedClient. Sin cast.
export const cliente: SeedClient = db;

// 2. De forma estructural, no por `any`: si `db` fuera `any`, la condicional
//    daria `boolean` y `Assert` no compilaria.
export type NoEsAny = Assert<typeof db extends SeedClient ? true : false>;

export async function contratos(): Promise<void> {
  // 3. runSeeders lo acepta tal cual.
  await runSeeders(db);

  // 4. El cliente de transaccion real encaja en el callback del contrato,
  //    aunque le falten $transaction, $connect y $disconnect.
  await db.$transaction(async (tx) => {
    const t: SeedClient = tx;
    await t.$queryRawUnsafe<{ n: number }[]>('SELECT 1 AS n');
    await t.$executeRawUnsafe('SELECT 1');
  });

  // 5. Y acepta las opciones que la libreria envia.
  await db.$transaction(async () => {}, { isolationLevel: undefined });
}
