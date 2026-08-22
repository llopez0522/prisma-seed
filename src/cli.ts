import { Command } from 'commander';
import pc from 'picocolors';

import { freshCommand } from './commands/fresh.js';
import { generateCommand } from './commands/generate.js';
import { refreshCommand } from './commands/refresh.js';
import { rollbackCommand } from './commands/rollback.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { CliError, EXIT, type ExitCode } from './core/errors.js';
import { VERSION } from './version.js';

/**
 * Punto de entrada del CLI.
 *
 * Es el unico sitio de todo el proyecto que decide codigos de salida. Los modulos
 * lanzan `CliError`; nadie llama a `process.exit` por su cuenta. En la v0.2.4 pasaba
 * lo contrario: habia `process.exit(1)` repartidos por modulos de libreria y, a la
 * vez, un `catch` en `generate` que se tragaba los fallos y salia con 0 (B11).
 */

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('prisma-seed')
    .description('Genera y gestiona seeders de Prisma con comandos al estilo Laravel.')
    .version(VERSION, '-v, --version', 'Muestra la version instalada.')
    .option('-q, --quiet', 'Solo muestra errores.')
    .option('--verbose', 'Muestra el detalle de cada paso.')
    .option(
      '--cwd <ruta>',
      'Raiz del proyecto. Por defecto se busca subiendo desde el directorio actual.'
    )
    .option('--no-transaction', 'No envuelve cada seeder en una transaccion.')
    .showHelpAfterError();

  /** Fusiona los flags globales con los del subcomando. */
  const globals = (cmd: Command): Record<string, unknown> => ({
    ...program.opts(),
    ...cmd.opts(),
  });

  program
    .command('generate')
    .argument('<nombre>', 'Nombre del seeder, p. ej. User')
    .option('--model <modelo>', 'Modelo de Prisma al que apunta, si difiere del nombre')
    .option('--ts', 'Fuerza TypeScript, aunque el proyecto no lo parezca')
    .option('--js', 'Fuerza JavaScript, aunque el proyecto sea TypeScript')
    .description('Crea un nuevo archivo de seeder.')
    .action(async (nombre: string, _opts, cmd: Command) => {
      await generateCommand(nombre, globals(cmd));
    });

  program
    .command('run')
    .argument('[nombre]', 'Ejecuta solo el seeder indicado')
    .option('--class <nombre>', 'Alias de [nombre], por familiaridad con Laravel')
    .option('--step <n>', 'Ejecuta solo los N siguientes pendientes')
    .option('--dry-run', 'Muestra que se ejecutaria, sin tocar la base de datos')
    .option('--force', 'Permite la ejecucion con NODE_ENV=production')
    .description('Ejecuta los seeders pendientes.')
    .action(async (nombre: string | undefined, _opts, cmd: Command) => {
      await runCommand(nombre, globals(cmd));
    });

  program
    .command('rollback')
    .argument('[nombre]', 'Revierte solo el seeder indicado')
    .option('--step <n>', 'Revierte los N ultimos seeders ejecutados')
    .option('--all', 'Revierte todo el historico, no solo el ultimo batch')
    .option('--dry-run', 'Muestra que se revertiria, sin tocar la base de datos')
    .option('--force', 'Permite la ejecucion con NODE_ENV=production')
    .description('Revierte el ultimo batch de seeders ejecutados.')
    .action(async (nombre: string | undefined, _opts, cmd: Command) => {
      await rollbackCommand(nombre, globals(cmd));
    });

  program
    .command('status')
    .description('Muestra el estado de cada seeder: pendiente o ejecutado, y en que lote.')
    .action(async (_opts, cmd: Command) => {
      await statusCommand(globals(cmd));
    });

  program
    .command('fresh')
    .option('--seed', 'Ejecuta los seeders despues de vaciar')
    .option('--force', 'Omite la confirmacion interactiva')
    .option('--dry-run', 'Muestra que tablas se vaciarian, sin tocar nada')
    .description('Vacia TODAS las tablas y resetea los autoincrementales.')
    .action(async (_opts, cmd: Command) => {
      await freshCommand(globals(cmd));
    });

  program
    .command('refresh')
    .option('--force', 'Permite la ejecucion con NODE_ENV=production')
    .option('--dry-run', 'Muestra que se revertiria y se ejecutaria')
    .description('Revierte todos los seeders y los vuelve a ejecutar.')
    .action(async (_opts, cmd: Command) => {
      await refreshCommand(globals(cmd));
    });

  return program;
}

/** Imprime un error de forma util y devuelve su codigo de salida. */
export function reportError(error: unknown): ExitCode {
  if (error instanceof CliError) {
    console.error(`${pc.red('✗')} ${error.message}`);
    if (error.hint !== undefined) console.error(`  ${pc.dim(error.hint)}`);
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`${pc.red('✗')} ${message}`);

  // El stack solo con --verbose: en uso normal es ruido.
  if (error instanceof Error && process.argv.includes('--verbose') && error.stack) {
    console.error(pc.dim(error.stack));
  }

  return EXIT.FAILURE;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

// Solo arranca cuando se ejecuta como binario, no al importarse desde los tests.
if (process.env['VITEST'] === undefined) {
  main().catch((error: unknown) => {
    process.exit(reportError(error));
  });
}
