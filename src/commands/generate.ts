import fs from 'node:fs';
import path from 'node:path';

import { buildLogger, projectRootFor, type GlobalFlags } from './context.js';
import { loadConfig } from '../core/config.js';
import { CliError, EXIT } from '../core/errors.js';
import { buildSeedFileName, toModelName } from '../core/naming.js';
import { hasPrismaClient } from '../core/prisma.js';
import { assertValidSeedName, discoverSeeders } from '../core/resolver.js';
import { extensionFor, renderTemplate, type TemplateFlavor } from '../templates/seeder.js';
import type { ClientTypeSpec, SeederLanguage } from '../types.js';

/**
 * `generate <nombre>`
 *
 * Correcciones respecto de la v0.2.4:
 *
 *  - **No abre conexion** (B4). Antes bastaba con importar el modulo para
 *    instanciar dos PrismaClient y abortar si faltaba `@prisma/client`.
 *  - **Valida el nombre** (B10). `generate ../../../../tmp/pwned` escribia fuera
 *    del directorio de seeders.
 *  - **Los errores se propagan** (B11). Antes un `catch` los tragaba y el proceso
 *    salia con codigo 0 aunque no hubiera generado nada.
 *  - **El accesor del modelo es correcto** (B9).
 *  - **La plantilla TypeScript no impone `@prisma/client`**. Si el proyecto no
 *    puede resolver ese paquete, importarlo generaria un archivo que no compila,
 *    asi que se emite una interfaz local y la receta para sustituirla.
 */

export interface GenerateOptions extends GlobalFlags {
  model?: string | undefined;
  ts?: boolean | undefined;
  js?: boolean | undefined;
}

/**
 * Decide como tipar el cliente en la plantilla TypeScript.
 *
 * Manda lo que diga la configuracion. Si no dice nada, la pregunta no es que ORM
 * usa el proyecto sino algo comprobable: **¿puede resolver `@prisma/client`?**
 * Si puede, se importa `PrismaClient` como siempre; si no, importarlo generaria
 * un archivo que no compila.
 */
export function resolveClientType(
  configured: ClientTypeSpec | undefined,
  prismaClientAvailable: boolean
): ClientTypeSpec | null | undefined {
  if (configured !== undefined) return configured;
  return prismaClientAvailable ? undefined : null;
}

/** Pistas para deducir el lenguaje, mas alla del `cwd`. */
export interface FlavorHints {
  /** Lo declarado en `seederLanguage`. Gana a cualquier deduccion. */
  configured?: SeederLanguage | undefined;
  /** Directorio de seeders, para imitar lo que ya hay escrito. */
  seedersDir?: string | undefined;
  /** `--js`: fuerza JavaScript aunque el proyecto sea TypeScript. */
  forceJs?: boolean | undefined;
}

export interface FlavorDecision {
  flavor: TemplateFlavor;
  /** Por que se eligio. Se imprime, para que nunca sea un misterio. */
  reason: string;
}

/** Lenguaje que implica una extension, o `null` si es ambigua (`.js`). */
function flavorOfExtension(ext: string): TemplateFlavor | null {
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';
  return null; // `.js` no dice nada: depende de package.json
}

/** ESM o CJS segun `package.json`. Es lo unico que ese campo puede decidir. */
function moduleSystem(cwd: string): TemplateFlavor {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'cjs';

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { type?: string };
    return pkg.type === 'module' ? 'esm' : 'cjs';
  } catch {
    // Un package.json ilegible no debe impedir generar: se asume CommonJS,
    // que es el valor por defecto de Node.
    return 'cjs';
  }
}

/**
 * Decide en que lenguaje se escribe el seeder.
 *
 * Antes solo se distinguia ESM de CommonJS y TypeScript habia que pedirlo con
 * `--ts` en cada invocacion. Era incoherente: si el proyecto es TypeScript, el
 * seeder debe salir en TypeScript sin que haya que recordarlo.
 *
 * La escalera, de mas fuerte a mas debil. Cada peldano es un hecho comprobable
 * del proyecto, no una suposicion sobre que ORM usa:
 *
 *  1. `--ts` / `--js` — lo que pide quien ejecuta el comando.
 *  2. `seederLanguage` en la configuracion — lo que decidio el proyecto.
 *  3. **Los seeders que ya existen.** Es la senal mas fiable: lo coherente es
 *     escribir el siguiente igual que el ultimo.
 *  4. **Hay `tsconfig.json`** — el proyecto es TypeScript.
 *  5. `package.json#type` — ESM o CommonJS.
 */
export function detectFlavor(
  cwd: string,
  forceTs: boolean | undefined,
  hints: FlavorHints = {}
): FlavorDecision {
  if (forceTs === true) return { flavor: 'ts', reason: '--ts' };

  if (hints.forceJs === true) {
    return { flavor: moduleSystem(cwd), reason: '--js' };
  }

  if (hints.configured !== undefined) {
    return { flavor: hints.configured, reason: 'seederLanguage en la configuracion' };
  }

  if (hints.seedersDir !== undefined) {
    const existentes = discoverSeeders(hints.seedersDir);
    const ultimo = existentes.at(-1);
    if (ultimo) {
      const deLaExtension = flavorOfExtension(path.extname(ultimo.absolutePath));
      if (deLaExtension !== null) {
        return { flavor: deLaExtension, reason: `los seeders que ya hay son ${deLaExtension}` };
      }
    }
  }

  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return { flavor: 'ts', reason: 'el proyecto tiene tsconfig.json' };
  }

  const sistema = moduleSystem(cwd);
  return {
    flavor: sistema,
    reason: `package.json declara ${sistema === 'esm' ? 'ESM' : 'CommonJS'}`,
  };
}

export async function generateCommand(name: string, options: GenerateOptions): Promise<void> {
  const cwd = projectRootFor(options);
  const logger = buildLogger(options);

  assertValidSeedName(name);
  if (options.model !== undefined) assertValidSeedName(options.model);

  const config = await loadConfig(cwd);
  const dir = config.seedersDirAbsolute;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Directorio creado: ${config.seedersDir}`);
  }

  const { flavor, reason } = detectFlavor(cwd, options.ts, {
    configured: config.seederLanguage,
    seedersDir: config.seedersDirAbsolute,
    forceJs: options.js,
  });
  const fileName = buildSeedFileName(name, extensionFor(flavor));
  const filePath = path.join(dir, fileName);

  // Con assertValidSeedName el nombre no puede contener separadores, asi que
  // esto es una segunda barrera: si alguna vez se relaja la validacion, el
  // archivo sigue sin poder salir del directorio.
  const resuelto = path.resolve(filePath);
  if (path.dirname(resuelto) !== path.resolve(dir)) {
    throw new CliError(
      `La ruta resultante queda fuera del directorio de seeders: ${resuelto}`,
      EXIT.USAGE
    );
  }

  if (fs.existsSync(filePath)) {
    throw new CliError(`El seeder "${fileName}" ya existe.`, EXIT.USAGE);
  }

  const clientType = resolveClientType(config.clientType, hasPrismaClient(cwd));

  const contenido = renderTemplate(flavor, {
    name,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(clientType !== undefined ? { clientType } : {}),
  });

  fs.writeFileSync(filePath, contenido, 'utf8');

  logger.success(`${fileName}`);
  logger.info(`  ${path.join(config.seedersDir, fileName)}`);
  logger.info(`  lenguaje: ${flavor} (${reason})`);
  logger.info(
    `  modelo: prisma.${toModelName(options.model ?? name).replace(/^./, (c) => c.toLowerCase())}`
  );
}
