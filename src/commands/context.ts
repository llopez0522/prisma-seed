import {
  createSeedRuntime,
  releaseSeedRuntime,
  resolveProjectRoot,
  type SeedRuntime,
} from '../core/context.js';
import { CliError, EXIT } from '../core/errors.js';
import { createLogger, levelFromFlags } from '../core/logger.js';
import type { Logger } from '../types.js';

/**
 * Arranque de los comandos que tocan la base de datos.
 *
 * Es una capa fina sobre `core/context.ts`: traduce flags del CLI a opciones y
 * anade las decisiones que solo tienen sentido en un binario — el nivel de log y
 * el cierre del cliente al terminar.
 *
 * `generate` NO usa esto: generar un archivo no necesita conexion, y hacerla
 * obligatoria era justamente B4.
 */

export interface GlobalFlags {
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  cwd?: string | undefined;
  noTransaction?: boolean | undefined;
}

/** El contexto del CLI es el runtime del nucleo, sin envoltorios. */
export type CommandContext = SeedRuntime;

export function buildLogger(flags: GlobalFlags): Logger {
  return createLogger({ level: levelFromFlags(flags) });
}

/** Raiz del proyecto para los comandos que no montan runtime (`generate`). */
export function projectRootFor(flags: GlobalFlags): string {
  return resolveProjectRoot(flags.cwd);
}

export async function createContext(flags: GlobalFlags): Promise<CommandContext> {
  return createSeedRuntime({
    cwd: flags.cwd,
    logger: buildLogger(flags),
    config: {
      ...(flags.noTransaction === true ? { transactional: false } : {}),
    },
  });
}

/**
 * Cierra el cliente al terminar un comando.
 *
 * El CLI es dueno del proceso, asi que cierra tambien los clientes que le presta
 * la configuracion — de otro modo el pool quedaria abierto y el proceso no
 * terminaria. Quien necesite lo contrario tiene `closeClient: false`.
 */
export async function closeContext(ctx: CommandContext): Promise<void> {
  await releaseSeedRuntime(ctx, { force: true });
}

/**
 * Impide operaciones destructivas contra produccion sin intencion explicita.
 *
 * Es la salvaguarda que Laravel aplica a `db:seed` y `migrate:fresh`.
 */
export function guardProduction(force: boolean | undefined, accion: string): void {
  if (process.env['NODE_ENV'] !== 'production') return;
  if (force === true) return;

  throw new CliError(
    `Rechazado: "${accion}" con NODE_ENV=production.`,
    EXIT.USAGE,
    'Si de verdad es lo que quieres, repite el comando con --force.'
  );
}
