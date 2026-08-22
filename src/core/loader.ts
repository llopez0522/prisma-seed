import { pathToFileURL } from 'node:url';

import { CliError, EXIT, toMessage } from './errors.js';
import type { SeederModule } from '../types.js';

/**
 * Carga de modulos de seeder.
 *
 * Sustituye a `loadModule` de la v0.2.4, que tenia tres problemas:
 *
 *  - Construia la URL como `new URL('file://' + rutaAbsoluta)` (B8). Eso rompe en
 *    Windows (`C:\...` no es una ruta URL valida) y con cualquier ruta que
 *    contenga espacios, `#` o `?`. `pathToFileURL` de node:url lo hace bien.
 *  - Su fallback a `require()` solo cubria dos codigos de error y en la practica
 *    no se alcanzaba, porque `import()` ya carga CommonJS sin ayuda.
 *  - No normalizaba el interop: un modulo CJS cargado con `import()` puede exponer
 *    sus exports bajo `.default` en vez de en la raiz, justo el mismo patron que
 *    hacia fallar a inquirer (B13).
 */

const SUPPORTED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'] as const;

export function isSupportedExtension(ext: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

/** Forma cruda de un namespace de modulo antes de normalizar el interop. */
interface RawModule {
  main?: unknown;
  down?: unknown;
  order?: unknown;
  dependencies?: unknown;
  default?: RawModule;
}

/**
 * Aplana el `.default` de los modulos CommonJS.
 *
 * Al importar CJS con `import()`, Node expone `module.exports` bajo `default` y
 * ademas intenta detectar los named exports con cjs-module-lexer. Cuando el lexer
 * no los detecta (por ejemplo con `module.exports = {...}` construido en runtime),
 * solo queda `default`. Se prefiere siempre la raiz y se cae a `default`.
 */
function unwrap(raw: RawModule): RawModule {
  const hasOwn = typeof raw.main === 'function' || typeof raw.down === 'function';
  if (hasOwn) return raw;
  if (raw.default && typeof raw.default === 'object') return raw.default;
  return raw;
}

function asFunction(value: unknown): ((...args: never[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...args: never[]) => unknown) : undefined;
}

/**
 * Importa un seeder y normaliza su forma.
 *
 * No valida que exista `main` o `down`: de eso se ocupa quien lo consume, que
 * sabe cual de los dos necesita.
 */
export async function loadSeederModule(absolutePath: string): Promise<SeederModule> {
  let namespace: RawModule;

  try {
    namespace = (await import(pathToFileURL(absolutePath).href)) as RawModule;
  } catch (error) {
    throw explainImportFailure(absolutePath, error);
  }

  const mod = unwrap(namespace);

  const result: SeederModule = {};
  const main = asFunction(mod.main);
  const down = asFunction(mod.down);
  if (main) result.main = main as NonNullable<SeederModule['main']>;
  if (down) result.down = down as NonNullable<SeederModule['down']>;
  if (typeof mod.order === 'number') result.order = mod.order;
  if (Array.isArray(mod.dependencies)) {
    result.dependencies = mod.dependencies.filter((d): d is string => typeof d === 'string');
  }

  return result;
}

/**
 * Convierte los fallos de import mas comunes en mensajes accionables.
 *
 * El caso importante es el de los seeders en TypeScript: Node no los ejecuta sin
 * un loader, y el error nativo (`Unknown file extension ".ts"`) no dice que hacer.
 */
function explainImportFailure(absolutePath: string, error: unknown): CliError {
  const message = toMessage(error);
  const code = (error as { code?: string } | null)?.code;

  if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || message.includes('Unknown file extension')) {
    return new CliError(
      `No se puede ejecutar el seeder TypeScript "${absolutePath}".`,
      EXIT.USAGE,
      'Node necesita un loader para .ts. Instala tsx (npm i -D tsx) y ejecuta el CLI ' +
        'con: npx tsx node_modules/prisma-seed/dist/cli.js <comando>. ' +
        'Usa el binario "tsx" y no "node --import tsx/esm": medido en un proyecto con ' +
        'alias "paths" en tsconfig, el segundo no los resuelve.'
    );
  }

  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return new CliError(
      `El seeder "${absolutePath}" importa un modulo que no existe: ${message}`,
      EXIT.FAILURE,
      'Comprueba que las dependencias del seeder esten instaladas en el proyecto.'
    );
  }

  return new CliError(`No se pudo cargar el seeder "${absolutePath}": ${message}`, EXIT.FAILURE);
}
