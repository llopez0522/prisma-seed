import fs from 'node:fs';
import path from 'node:path';

/**
 * Localizacion de la raiz del proyecto y de su schema.
 *
 * Existe por dos motivos:
 *
 *  - **La raiz**. Hasta ahora todo colgaba de `process.cwd()`, asi que
 *    `npx prisma-seed run` desde `apps/api/src` buscaba
 *    `apps/api/src/prisma/seeders` y no encontraba nada. Se sube por el arbol
 *    hasta la primera carpeta que parezca la raiz de un proyecto.
 *  - **El schema**. Se busca en las ubicaciones habituales: `prisma/schema.prisma`
 *    y `schema.zmodel` (que es lo que genera el CLI de ZenStack). Los dos
 *    declaran el mismo bloque `datasource`, asi que basta con dar con el archivo;
 *    de ahi solo se lee el `provider`.
 *
 * Nada de esto adivina en silencio: si no encuentra un candidato, se devuelve el
 * valor por defecto de siempre y quien lo consume falla con un mensaje concreto.
 */

/** Cuantos niveles se sube como maximo buscando la raiz. */
const MAX_ASCENT = 12;

/** Marcadores que identifican la raiz de un proyecto, por orden de fuerza. */
const ROOT_MARKERS = ['package.json', 'prisma', 'zenstack'] as const;

function looksLikeProjectRoot(dir: string): boolean {
  return ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

/**
 * Sube desde `startDir` hasta la primera carpeta con pinta de raiz de proyecto.
 *
 * Si no encuentra ninguna, devuelve `startDir` sin tocar. Esa es la parte
 * importante: en un directorio temporal sin `package.json` — el caso de media
 * suite de tests — el comportamiento es exactamente el de antes, en lugar de
 * escaparse hacia arriba y escribir donde no debe.
 */
export function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);

  for (let level = 0; level < MAX_ASCENT; level += 1) {
    if (looksLikeProjectRoot(current)) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(startDir);
}

/**
 * Candidatos de schema, en orden de preferencia.
 *
 * Prisma primero para no cambiar el comportamiento de ningun proyecto existente;
 * ZenStack v3 despues.
 */
export const SCHEMA_CANDIDATES = [
  'prisma/schema.prisma',
  'zenstack/schema.zmodel',
  'schema.zmodel',
  'prisma/schema.zmodel',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lee `zenstack.schema` o `prisma.schema` del package.json.
 *
 * Las dos herramientas documentan esa clave como la forma de mover el schema:
 * ZenStack en su CLI reference, Prisma en `prisma.schema`. Respetarla evita que
 * el usuario tenga que repetir la ruta en `seeder.config`.
 */
export function schemaPathFromPackageJson(cwd: string): string | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    // Un package.json ilegible ya se diagnostica en config.ts; aqui solo
    // significa "no hay pista", no un error.
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  for (const key of ['zenstack', 'prisma'] as const) {
    const section = parsed[key];
    if (!isPlainObject(section)) continue;
    const schema = section['schema'];
    if (typeof schema === 'string' && schema.trim() !== '') return schema;
  }

  return null;
}

/**
 * Devuelve la ruta relativa del schema del proyecto, o `null` si no hay ninguno.
 *
 * Se prefiere lo declarado en package.json; despues, el primer candidato que
 * exista en disco.
 */
export function discoverSchemaPath(cwd: string): string | null {
  const declared = schemaPathFromPackageJson(cwd);
  if (declared !== null && fs.existsSync(path.resolve(cwd, declared))) return declared;

  for (const candidate of SCHEMA_CANDIDATES) {
    if (fs.existsSync(path.resolve(cwd, candidate))) return candidate;
  }

  // Declarado pero inexistente: se devuelve igualmente para que el error apunte
  // a la ruta que el usuario configuro, no a una generica.
  return declared;
}
