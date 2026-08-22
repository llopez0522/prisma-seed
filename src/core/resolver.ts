import fs from 'node:fs';
import path from 'node:path';

import { UsageError } from './errors.js';
import { isSupportedExtension } from './loader.js';
import type { DiscoveredSeeder } from '../types.js';

/**
 * Descubrimiento, ordenacion y busqueda de seeders en disco.
 *
 * Correcciones respecto de la v0.2.4:
 *
 *  - El nombre canonico se obtiene con `path.parse().name`, no con
 *    `file.replace('.js', '')`. El replace sustituia la *primera* aparicion de la
 *    subcadena, asi que un seeder llamado `20240101_Post.js.backup.js` o
 *    `Archive.js.js` daba un nombre corrupto.
 *  - Se aceptan `.mjs`, `.cjs` y TypeScript, no solo `.js`.
 *  - La busqueda por nombre distingue coincidencia exacta de parcial y falla de
 *    forma explicita cuando hay ambiguedad, en vez de elegir en silencio.
 */

/** Prefijo `YYYYMMDDHHmmss_` que genera el comando `generate`. */
const TIMESTAMP_PREFIX = /^(\d{14})_/;

/**
 * Nombres validos de seeder. Deliberadamente restrictivo: cierra el escape de
 * directorio de B10 (`generate ../../../../tmp/pwned`) por construccion, sin
 * depender de comparar rutas resueltas.
 */
const VALID_SEED_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function isValidSeedName(name: string): boolean {
  return VALID_SEED_NAME.test(name);
}

export function assertValidSeedName(name: string): void {
  if (!isValidSeedName(name)) {
    throw new UsageError(
      `Nombre de seeder invalido: "${name}".`,
      'Debe empezar por una letra y contener solo letras, numeros, guion y guion bajo.'
    );
  }
}

/** Lee el directorio de seeders y devuelve los candidatos ordenados. */
export function discoverSeeders(seedersDir: string): DiscoveredSeeder[] {
  if (!fs.existsSync(seedersDir)) return [];

  const entries = fs.readdirSync(seedersDir, { withFileTypes: true });

  const seeders = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => isSupportedExtension(path.extname(file)))
    // Los .d.ts no son seeders, son declaraciones de tipos.
    .filter((file) => !file.endsWith('.d.ts'))
    .map<DiscoveredSeeder>((file) => {
      const name = path.parse(file).name;
      const match = TIMESTAMP_PREFIX.exec(name);
      return {
        name,
        absolutePath: path.join(seedersDir, file),
        timestamp: match?.[1] ?? null,
      };
    });

  return sortSeeders(seeders);
}

/**
 * Orden de ejecucion.
 *
 * Los que llevan prefijo de timestamp van primero y en orden cronologico; el
 * resto despues, alfabeticamente. Asi los seeders generados por la herramienta
 * mantienen su orden y los escritos a mano quedan al final de forma predecible.
 */
export function sortSeeders(seeders: DiscoveredSeeder[]): DiscoveredSeeder[] {
  return [...seeders].sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      return a.timestamp === b.timestamp
        ? a.name.localeCompare(b.name)
        : a.timestamp.localeCompare(b.timestamp);
    }
    if (a.timestamp) return -1;
    if (b.timestamp) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Busca un seeder por nombre, al estilo de `db:seed --class=` de Laravel.
 *
 * Estrategia por prioridad decreciente: exacto, exacto sin distinguir
 * mayusculas, y por ultimo parcial ignorando el prefijo de timestamp — que es lo
 * que permite escribir `run User` en vez de `run 20240101120000_User`.
 */
export function findSeederByName(
  seeders: DiscoveredSeeder[],
  query: string
): DiscoveredSeeder | never {
  const exact = seeders.filter((s) => s.name === query);
  if (exact.length === 1) return exact[0]!;

  const lower = query.toLowerCase();

  const caseInsensitive = seeders.filter((s) => s.name.toLowerCase() === lower);
  if (caseInsensitive.length === 1) return caseInsensitive[0]!;

  const withoutTimestamp = seeders.filter((s) => stripTimestamp(s.name).toLowerCase() === lower);
  if (withoutTimestamp.length === 1) return withoutTimestamp[0]!;

  const partial = seeders.filter((s) => s.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;

  const candidates = withoutTimestamp.length > 0 ? withoutTimestamp : partial;

  if (candidates.length === 0) {
    throw new UsageError(
      `No existe ningun seeder que coincida con "${query}".`,
      seeders.length === 0
        ? 'El directorio de seeders esta vacio. Crea uno con: prisma-seed generate <nombre>'
        : `Disponibles: ${seeders.map((s) => s.name).join(', ')}`
    );
  }

  throw new UsageError(
    `"${query}" es ambiguo: coincide con ${candidates.length} seeders.`,
    `Concreta cual: ${candidates.map((s) => s.name).join(', ')}`
  );
}

/** Quita el prefijo `YYYYMMDDHHmmss_` si lo hay. */
export function stripTimestamp(name: string): string {
  return name.replace(TIMESTAMP_PREFIX, '');
}
