// Sonda de dialecto (Fase 0, B3).
//
// Ejecuta LITERALMENTE las sentencias que emite runner/run-seeds.js contra el
// motor configurado en DATABASE_URL, para medir que parte de la sintaxis es
// exclusiva de Postgres. Se ejecuta con el cwd en el fixture correspondiente.
//
//   uso: node /app/.fixtures/probe-dialect.js <etiqueta>

const label = process.argv[2] || 'desconocido';
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

async function probe(name, fn) {
  try {
    const r = await fn();
    console.log(`  PASS  ${name}  -> ${JSON.stringify(r)}`);
    return true;
  } catch (e) {
    const msg = String(e.message).split('\n').filter(Boolean).pop().trim();
    console.log(`  FAIL  ${name}  -> [${e.code || e.name}] ${msg}`);
    return false;
  }
}

(async () => {
  console.log(`\n=== dialecto: ${label} ===`);

  // 1. El CREATE TABLE de la rama de autocreacion.
  await probe('CREATE TABLE (SERIAL + "identificador")', () =>
    prisma.$executeRawUnsafe(CREATE_TABLE));

  // 2. La comprobacion de existencia: identificador entre comillas dobles.
  await probe('SELECT 1 FROM "SeedExecution"        ', () =>
    prisma.$queryRawUnsafe('SELECT 1 FROM "SeedExecution" LIMIT 1'));

  // 3. Placeholder posicional $1 (sintaxis Postgres).
  await probe('INSERT con placeholder $1            ', () =>
    prisma.$queryRawUnsafe('INSERT INTO "SeedExecution" ("seedName") VALUES ($1);', 'probe'));

  // 4. Placeholder ? (sintaxis MySQL/SQLite), como control.
  await probe('INSERT con placeholder ?  (control)  ', () =>
    prisma.$queryRawUnsafe('INSERT INTO "SeedExecution" ("seedName") VALUES (?);', 'probe2'));

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('  ERROR fatal:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
