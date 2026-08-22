/**
 * Escribe y despues falla, para comprobar contra la base real que la transaccion
 * deshace tanto el dato como su registro en el ledger (B7).
 *
 * Vive en su propio directorio para no contaminar la ejecucion normal.
 */
import type { SeedContext } from 'prisma-seed';

export async function main({ prisma }: SeedContext): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "psc_seed_probe" ("clave", "valor") VALUES ($1, $2)`,
    'explota',
    'no deberia quedar'
  );

  throw new Error('el seeder falla a proposito despues de escribir');
}

export async function down(): Promise<void> {
  // Nada que revertir: main() nunca llega a confirmar.
}
