/**
 * Errores del CLI con codigo de salida explicito.
 *
 * La v0.2.4 mezclaba dos antipatrones: `process.exit(1)` dentro de modulos de
 * libreria (lo que impide testearlos y aborta procesos ajenos) y `catch` que solo
 * loguean, dejando exit 0 en un fallo real (B11). Aqui los modulos lanzan y solo
 * el punto de entrada decide el codigo de salida.
 */

export const EXIT = {
  /** Todo correcto. */
  SUCCESS: 0,
  /** Un seeder fallo, o fallo la operacion pedida. */
  FAILURE: 1,
  /** Uso incorrecto: argumento invalido, comando desconocido, nombre ambiguo. */
  USAGE: 2,
  /** No se pudo conectar o resolver el cliente de Prisma. */
  CONNECTION: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** Sugerencia accionable que se imprime bajo el mensaje. */
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCode = EXIT.FAILURE, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.USAGE, hint);
    this.name = 'UsageError';
  }
}

export class ConnectionError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.CONNECTION, hint);
    this.name = 'ConnectionError';
  }
}

/** Extrae un mensaje legible de cualquier valor lanzado. */
export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
