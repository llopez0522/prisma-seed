// Fase 0, B3 (SQLite): la sonda de dialecto pasa las 4 sentencias en SQLite,
// pero "pasar" no es lo mismo que "hacer lo correcto". SQLite acepta nombres de
// tipo arbitrarios por su sistema de afinidad, asi que `id SERIAL PRIMARY KEY`
// se acepta sin ser un alias de rowid. Este script comprueba si realmente
// autoincrementa, todo dentro de una sola ejecucion de contenedor.

const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [process.cwd()] }));
const prisma = new PrismaClient();

// Copiado tal cual de run-seeds.js:17-23.
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS "SeedExecution" (
    id SERIAL PRIMARY KEY,
    seedName VARCHAR(255) UNIQUE,
    executedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

(async () => {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "SeedExecution";');
  await prisma.$executeRawUnsafe(CREATE_TABLE);

  const ddl = await prisma.$queryRawUnsafe(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='SeedExecution'`
  );
  console.log('DDL almacenado:\n', ddl[0] && ddl[0].sql, '\n');

  // Insercion tal como la hace runFileSeeds: sin especificar id.
  await prisma.$executeRawUnsafe('INSERT INTO "SeedExecution" ("seedName") VALUES ($1);', 'seed_a');
  await prisma.$executeRawUnsafe('INSERT INTO "SeedExecution" ("seedName") VALUES ($1);', 'seed_b');

  const rows = await prisma.$queryRawUnsafe('SELECT id, seedName, executedAt FROM "SeedExecution";');
  console.log('filas tras dos inserciones:');
  for (const r of rows) console.log('  ', JSON.stringify(r));

  const nulos = rows.filter((r) => r.id === null).length;
  console.log(`\n=> ids nulos: ${nulos}/${rows.length}`);
  console.log(nulos > 0
    ? '=> CONFIRMADO: `id SERIAL PRIMARY KEY` NO autoincrementa en SQLite. Fallo silencioso.'
    : '=> El id si se autoasigna.');

  // El orden de rollback depende de executedAt; comprobamos su granularidad.
  const distintos = new Set(rows.map((r) => String(r.executedAt))).size;
  console.log(`=> valores distintos de executedAt: ${distintos}/${rows.length}` +
    (distintos < rows.length ? '  (empate: orden de rollback indeterminado, B6)' : ''));

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message.split('\n').filter(Boolean).pop().trim());
  await prisma.$disconnect();
  process.exit(1);
});
