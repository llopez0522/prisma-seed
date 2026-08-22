/**
 * Conversion de nombres.
 *
 * B9: la v0.2.4 generaba el accesor del modelo con `seedName.toLowerCase()`, asi
 * que `generate UserProfile` producia `prisma.userprofile.upsert(...)`. Ese
 * accesor no existe: Prisma expone `prisma.userProfile`. Verificado en la fase 0.
 * La regla real de Prisma es minuscula solo en la primera letra, conservando el
 * resto del nombre del modelo.
 */

/** Nombre del modelo tal como se declara en schema.prisma: `userProfile` -> `UserProfile`. */
export function toModelName(input: string): string {
  const limpio = input.trim();
  if (limpio === '') return limpio;

  // snake_case y kebab-case se convierten a PascalCase; lo demas solo se
  // capitaliza, para no destrozar un `UserProfile` que ya venia bien.
  if (/[_-]/.test(limpio)) {
    return limpio
      .split(/[_-]+/)
      .filter(Boolean)
      .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
      .join('');
  }

  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/**
 * Accesor del cliente de Prisma para un modelo.
 *
 * Prisma pone en minuscula unicamente la primera letra: `UserProfile` da
 * `userProfile`, no `userprofile`.
 */
export function toModelAccessor(modelName: string): string {
  const modelo = toModelName(modelName);
  if (modelo === '') return modelo;
  return modelo.charAt(0).toLowerCase() + modelo.slice(1);
}

/**
 * Prefijo de ordenacion `YYYYMMDDHHmmss`.
 *
 * Se conserva el formato de la v0.2.4 para que los seeders ya existentes sigan
 * ordenandose junto a los nuevos.
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number, ancho = 2): string => String(n).padStart(ancho, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/** Nombre de archivo del seeder. */
export function buildSeedFileName(
  modelName: string,
  extension: string,
  date: Date = new Date()
): string {
  return `${formatTimestamp(date)}_${toModelName(modelName)}${extension}`;
}
