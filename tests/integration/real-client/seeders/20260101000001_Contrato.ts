/**
 * Seeder de verificacion contra un cliente real.
 *
 * Solo usa las capacidades del contrato, asi que sirve para cualquier proyecto
 * sin conocer sus modelos. Deja constancia de si el contexto le entrego el mismo
 * objeto en `prisma` y en `client`.
 */
import type { SeedContext } from 'prisma-seed';

type Ctx = SeedContext;

export async function main({ prisma, client, logger, name }: Ctx): Promise<void> {
  const alias = prisma === client ? 'alias-ok' : 'alias-ROTO';

  await prisma.$executeRawUnsafe(
    `INSERT INTO "psc_seed_probe" ("clave", "valor") VALUES ($1, $2)`,
    'contrato',
    alias
  );

  const filas = await prisma.$queryRawUnsafe<{ clave: string }[]>(
    `SELECT "clave" FROM "psc_seed_probe" ORDER BY "clave"`
  );

  logger.info(`${name}: ${alias}, ${filas.length} fila(s)`);
}

export async function down({ prisma, logger, name }: Ctx): Promise<void> {
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM "psc_seed_probe" WHERE "clave" = $1`,
    'contrato'
  );
  logger.info(`${name}: ${n} eliminada(s)`);
}
