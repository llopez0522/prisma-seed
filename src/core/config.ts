import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CliError, EXIT, toMessage } from './errors.js';
import { discoverSchemaPath } from './project.js';
import type { SeederConfig, UserSeederConfig } from '../types.js';

/**
 * Configuracion del proyecto.
 *
 * La v0.2.4 tenia `prisma/seeders` incrustado en dos archivos distintos y ninguna
 * forma de cambiarlo. Aqui hay valores por defecto identicos a los de antes (para
 * no romper a nadie) y tres formas de sobreescribirlos.
 */

export const DEFAULT_CONFIG: Omit<
  SeederConfig,
  'provider' | 'client' | 'closeClient' | 'clientType' | 'seederLanguage' | 'freshExclude'
> = {
  seedersDir: 'prisma/seeders',
  schemaPath: 'prisma/schema.prisma',
  ledgerTable: 'SeedExecution',
  transactional: true,
  transactionTimeout: 300_000,
};

/** Nombres de archivo de configuracion, en orden de preferencia. */
const CONFIG_FILES = [
  'seeder.config.ts',
  'seeder.config.mts',
  'seeder.config.js',
  'seeder.config.mjs',
  'seeder.config.cjs',
];

/** Config ya resuelta: rutas absolutas y todos los campos presentes. */
export interface ResolvedConfig extends SeederConfig {
  /** Raiz del proyecto del usuario. */
  cwd: string;
  /** `seedersDir` resuelto a ruta absoluta. */
  seedersDirAbsolute: string;
  /** `schemaPath` resuelto a ruta absoluta. */
  schemaPathAbsolute: string;
  /** Archivo de configuracion usado, si habia alguno. */
  sourceFile: string | null;
  /** Si `schemaPath` lo escribio el usuario o lo dedujo la libreria. */
  schemaPathDetected: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lee la clave `prismaSeeder` del package.json del proyecto, si existe. */
function readFromPackageJson(cwd: string): UserSeederConfig {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!isPlainObject(parsed)) return {};
    const section = parsed['prismaSeeder'];
    return isPlainObject(section) ? section : {};
  } catch (error) {
    throw new CliError(`No se pudo leer package.json en "${cwd}": ${toMessage(error)}`, EXIT.USAGE);
  }
}

/** Localiza el archivo de configuracion, si el proyecto tiene uno. */
export function findConfigFile(cwd: string): string | null {
  for (const name of CONFIG_FILES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Importa el archivo de configuracion.
 *
 * El caso que merece un mensaje propio es el de `seeder.config.ts`: es
 * exactamente donde un proyecto con ZenStack v3 pondra la fabrica del cliente, y
 * Node no ejecuta TypeScript sin un loader. El error nativo
 * (`Unknown file extension ".ts"`) no dice que hacer.
 */
async function readFromConfigFile(file: string): Promise<UserSeederConfig> {
  let mod: { default?: unknown; config?: unknown };

  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown; config?: unknown };
  } catch (error) {
    const message = toMessage(error);
    const code = (error as { code?: string } | null)?.code;

    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || message.includes('Unknown file extension')) {
      throw new CliError(
        `No se puede cargar "${path.basename(file)}": Node no ejecuta TypeScript sin un loader.`,
        EXIT.USAGE,
        'Instala tsx (npm i -D tsx) y ejecuta el CLI con: ' +
          'npx tsx node_modules/prisma-seed/dist/cli.js <comando>. ' +
          'La alternativa es renombrarlo a seeder.config.mjs.'
      );
    }

    throw new CliError(
      `No se pudo cargar la configuracion desde "${file}": ${message}`,
      EXIT.USAGE,
      'Debe exportar por defecto un objeto, p. ej.: export default defineConfig({ ... })'
    );
  }

  const exported = mod.default ?? mod.config;
  if (!isPlainObject(exported)) {
    throw new CliError(
      `No se pudo cargar la configuracion desde "${file}": debe exportar por defecto un objeto de configuracion.`,
      EXIT.USAGE,
      'Debe exportar por defecto un objeto, p. ej.: export default defineConfig({ ... })'
    );
  }

  return exported;
}

function validate(config: SeederConfig): void {
  if (config.seedersDir.trim() === '') {
    throw new CliError('"seedersDir" no puede estar vacio.', EXIT.USAGE);
  }
  if (config.ledgerTable.trim() === '') {
    throw new CliError('"ledgerTable" no puede estar vacio.', EXIT.USAGE);
  }
  // El nombre de la tabla acaba en SQL crudo. Restringirlo evita tener que
  // confiar en el escapado del dialecto para un valor que controla el usuario.
  if (config.transactionTimeout <= 0 || !Number.isFinite(config.transactionTimeout)) {
    throw new CliError(
      `"transactionTimeout" debe ser un numero positivo de milisegundos.`,
      EXIT.USAGE
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.ledgerTable)) {
    throw new CliError(
      `"ledgerTable" no es un identificador SQL valido: "${config.ledgerTable}".`,
      EXIT.USAGE,
      'Usa solo letras, numeros y guion bajo, empezando por letra o guion bajo.'
    );
  }
  if (
    config.seederLanguage !== undefined &&
    !['ts', 'esm', 'cjs'].includes(config.seederLanguage)
  ) {
    throw new CliError(
      `"seederLanguage" debe ser "ts", "esm" o "cjs", no "${String(config.seederLanguage)}".`,
      EXIT.USAGE
    );
  }
  if (config.freshExclude !== undefined) {
    if (
      !Array.isArray(config.freshExclude) ||
      config.freshExclude.some((t) => typeof t !== 'string')
    ) {
      throw new CliError('"freshExclude" debe ser un array de nombres de tabla.', EXIT.USAGE);
    }
  }
  if (config.clientType !== undefined) {
    const { import: importLine, type } = config.clientType;
    if (typeof importLine !== 'string' || typeof type !== 'string') {
      throw new CliError(
        '"clientType" debe tener las claves "import" y "type", ambas cadenas.',
        EXIT.USAGE,
        "Ejemplo: clientType: { import: \"import type { db } from '../../src/db'\", type: 'typeof db' }"
      );
    }
  }
  if (config.client !== undefined) {
    const kind = typeof config.client;
    if (kind !== 'function' && kind !== 'object') {
      throw new CliError(
        `"client" debe ser un cliente o una funcion que lo devuelva, no ${kind}.`,
        EXIT.USAGE,
        'Ejemplo: export default defineConfig({ client: () => db })'
      );
    }
  }
}

/**
 * Resuelve la configuracion efectiva.
 *
 * Precedencia, de menor a mayor: valores por defecto < package.json
 * (`prismaSeeder`) < seeder.config.* < overrides pasados por linea de comandos.
 *
 * `schemaPath` es el unico campo con un paso extra: si **nadie** lo declara, se
 * autodetecta antes de caer al valor por defecto, para que un proyecto de
 * ZenStack v3 (`zenstack/schema.zmodel`) funcione sin configurar nada.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  overrides: UserSeederConfig = {}
): Promise<ResolvedConfig> {
  const fromPackageJson = stripUndefined(readFromPackageJson(cwd));
  const configFile = findConfigFile(cwd);
  const fromFile = configFile ? stripUndefined(await readFromConfigFile(configFile)) : {};
  const fromOverrides = stripUndefined(overrides);

  const declaredSchemaPath =
    fromOverrides.schemaPath ?? fromFile.schemaPath ?? fromPackageJson.schemaPath;
  const schemaPathDetected = declaredSchemaPath === undefined;
  const schemaPath = declaredSchemaPath ?? discoverSchemaPath(cwd) ?? DEFAULT_CONFIG.schemaPath;

  const merged: SeederConfig = {
    ...DEFAULT_CONFIG,
    ...fromPackageJson,
    ...fromFile,
    ...fromOverrides,
    schemaPath,
  };

  validate(merged);

  return {
    ...merged,
    cwd,
    seedersDirAbsolute: path.resolve(cwd, merged.seedersDir),
    schemaPathAbsolute: path.resolve(cwd, merged.schemaPath),
    sourceFile: configFile,
    schemaPathDetected,
  };
}

/**
 * Quita las claves con valor `undefined`.
 *
 * Sin esto, un `{ seedersDir: undefined }` explicito en una capa pisaria el valor
 * de la capa inferior al hacer el spread, en lugar de dejarlo pasar.
 */
function stripUndefined<T extends object>(obj: T): StripUndefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  ) as StripUndefined<T>;
}

/**
 * Claves opcionales cuyo valor ya no puede ser `undefined`.
 *
 * El tipo tiene que reflejar lo que la funcion garantiza en runtime; si no,
 * `exactOptionalPropertyTypes` rechaza el objeto fusionado por conservar
 * `undefined` en la union.
 */
type StripUndefined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
