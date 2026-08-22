/**
 * Segundo seeder: comprueba el orden y que el ledger agrupa por batch.
 */
import type { SeedContext } from 'prisma-seed';

type Ctx = SeedContext;

export async function main({ prisma, logger, name }: Ctx): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "psc_seed_probe" ("clave", "valor") VALUES ($1, $2)`,
    'segundo',
    'ok'
  );
  logger.info(`${name}: insertado`);
}

export async function down({ prisma, logger, name }: Ctx): Promise<void> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM "psc_seed_probe" WHERE "clave" = $1`,
    'segundo'
  );
  logger.info(`${name}: ${n} eliminada(s)`);
}
