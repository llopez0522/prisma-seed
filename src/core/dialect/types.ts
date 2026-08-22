/**
 * Contrato de dialecto SQL.
 *
 * Existe por B3: la v0.2.4 emitia sintaxis exclusiva de Postgres (`SERIAL`,
 * placeholders `$1`, identificadores entre comillas dobles) contra cualquier
 * motor. La verificacion de la fase 0 midio el resultado:
 *
 *  - **MySQL**: las 4 sentencias fallan con error 1064. En su `sql_mode` por
 *    defecto, `"SeedExecution"` es una cadena literal, no un identificador.
 *  - **SQLite**: las 4 sentencias "pasan", pero `id SERIAL PRIMARY KEY` no es
 *    alias de rowid, asi que la clave primaria queda entera a NULL. Un fallo
 *    silencioso, peor que el error de MySQL.
 *
 * Cada motor implementa aqui lo que le es propio y el resto del codigo no vuelve
 * a escribir SQL a mano.
 */

/** Nombres de las columnas del ledger. Fijos, no configurables. */
export const LEDGER_COLUMNS = {
  id: 'id',
  seedName: 'seedName',
  batch: 'batch',
  executedAt: 'executedAt',
} as const;

/** Una sentencia del plan de vaciado. */
export interface TruncateStatement {
  sql: string;
  /**
   * Si al ejecutarla el motor dice que la tabla no existe, se ignora.
   *
   * Existe por SQLite: `sqlite_sequence` se crea la primera vez que se declara
   * una tabla con `AUTOINCREMENT`, asi que en una base que no tenga ninguna
   * sencillamente no esta, y borrarla seria un error legitimo que no debe
   * abortar el vaciado. Lo declara el dialecto porque es el unico que sabe que
   * sentencias suyas son de mejor esfuerzo.
   */
  optional?: boolean;
}

export interface Dialect {
  readonly name: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver';

  /** Entrecomilla un identificador segun las reglas del motor. */
  quote(identifier: string): string;

  /**
   * Placeholder posicional del parametro n (1-indexado).
   * Postgres usa `$1`, MySQL y SQLite `?`, SQL Server `@P1`.
   */
  placeholder(n: number): string;

  /** DDL idempotente que crea la tabla del ledger con los tipos correctos. */
  createLedgerTable(table: string): string;

  /**
   * Consulta que devuelve una fila por cada columna `column` existente en
   * `table`. Se usa para migrar ledgers de la v0.2.4, que no tienen `batch`.
   */
  columnExists(table: string, column: string): { sql: string; params: unknown[] };

  /** DDL que anade la columna `batch` a un ledger preexistente. */
  addBatchColumn(table: string): string;

  /**
   * Discrimina "la tabla no existe" del resto de errores.
   *
   * B14: Prisma marca *todo* error de raw query como P2010, asi que el codigo de
   * Prisma no sirve para distinguir. Hay que mirar el codigo nativo del motor.
   */
  isMissingTableError(error: unknown): boolean;

  /**
   * Consulta que devuelve una fila `{ name }` por cada tabla de usuario del
   * esquema actual. La usa `fresh` para saber que vaciar.
   *
   * "De usuario" significa: sin las tablas internas del motor. Las de
   * bookkeeping de las migraciones (`_prisma_migrations`) las filtra quien
   * consume, no el dialecto, porque no son cosa del motor sino del ORM.
   */
  listTables(): { sql: string; params: unknown[] };

  /** Sentencias que vacian las tablas y resetean los autoincrementales. */
  truncateAll(tables: string[]): TruncateStatement[];
}

/**
 * Profundidad maxima al recorrer la cadena de `cause`.
 *
 * ZenStack v3 envuelve el error del driver, y algunos drivers vuelven a
 * envolverlo. Tres niveles cubren los casos reales sin arriesgar un ciclo.
 */
const MAX_CAUSE_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asCode(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Recoge todos los codigos de error nativos plausibles, por orden de fiabilidad.
 *
 * Cada cliente coloca el codigo del motor en un sitio distinto:
 *
 * | Origen | Donde esta el codigo nativo |
 * |---|---|
 * | Prisma 5/6 | `error.meta.code` (`error.code` siempre es `P2010`) |
 * | ZenStack v3 | `error.dbErrorCode` (documentado en `orm/errors`) |
 * | Driver suelto o dentro de `cause` | `code`, `errno` o `sqlState` |
 *
 * Se devuelven todos en vez de uno solo porque el mismo fallo puede identificarse
 * de dos formas: mysql2, por ejemplo, expone `code: 'ER_NO_SUCH_TABLE'` y
 * `errno: 1146`, y segun por donde llegue el error se ve uno u otro.
 *
 * `error.code` del nivel raiz se recoge el ultimo a proposito: en Prisma vale
 * `P2010`, que ningun dialecto reconoce, asi que incluirlo es inocuo, y en un
 * error de driver sin envolver es justo el dato que hace falta.
 */
export function nativeErrorCodes(error: unknown): string[] {
  const found: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || !isRecord(value)) return;

    // Prisma: el codigo del motor viaja dentro de `meta`.
    const meta = value['meta'];
    if (isRecord(meta)) {
      const code = asCode(meta['code']);
      if (code !== null) found.push(code);
    }

    // ZenStack v3: `ORMError.dbErrorCode`.
    const dbErrorCode = asCode(value['dbErrorCode']);
    if (dbErrorCode !== null) found.push(dbErrorCode);

    // Driver: pg usa `code`, mysql2 `code` + `errno`, y varios exponen `sqlState`.
    for (const key of ['code', 'errno', 'sqlState'] as const) {
      const code = asCode(value[key]);
      if (code !== null) found.push(code);
    }

    visit(value['cause'], depth + 1);
  };

  visit(error, 0);

  return [...new Set(found)];
}

/**
 * Extrae el codigo nativo mas fiable del motor.
 *
 * Se conserva por compatibilidad y porque en la mayoria de los casos hay uno solo.
 */
export function nativeErrorCode(error: unknown): string | null {
  return nativeErrorCodes(error)[0] ?? null;
}

/** Si alguno de los codigos que trae el error esta en la lista. */
export function matchesNativeCode(error: unknown, codes: readonly string[]): boolean {
  const found = nativeErrorCodes(error);
  return codes.some((code) => found.includes(code));
}

/**
 * Extrae el mensaje nativo del motor.
 *
 * Concatena lo que encuentra en la cadena de `cause` porque SQLite no tiene
 * codigos de error utiles y la unica pista ("no such table") puede quedar dos
 * niveles por debajo del error que ve el nucleo.
 */
export function nativeErrorMessage(error: unknown): string {
  const parts: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH) return;

    if (isRecord(value)) {
      const meta = value['meta'];
      if (isRecord(meta) && typeof meta['message'] === 'string') parts.push(meta['message']);

      // ZenStack v3: `ORMError.dbErrorMessage`.
      if (typeof value['dbErrorMessage'] === 'string') parts.push(value['dbErrorMessage']);
    }

    if (value instanceof Error) parts.push(value.message);

    if (isRecord(value)) visit(value['cause'], depth + 1);
  };

  visit(error, 0);

  return parts.join(' | ');
}

/**
 * Motivo de un `ORMError` de ZenStack v3, si el error lo es.
 *
 * Valores documentados en `orm/errors`: `config-error`, `invalid-input`,
 * `not-found`, `rejected-by-policy`, `db-query-error`, `not-supported`,
 * `internal-error`.
 */
export function ormErrorReason(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const reason = error['reason'];
  return typeof reason === 'string' ? reason : null;
}

/**
 * Si el error viene de que una politica de acceso rechazo la operacion.
 *
 * Es el fallo caracteristico de ZenStack v3 cuando el ledger intenta ejecutar SQL
 * crudo sobre un cliente con `PolicyPlugin`: el plugin bloquea `$queryRaw` y
 * `$executeRaw` salvo que se active `dangerouslyAllowRawSql`.
 */
export function isPolicyRejection(error: unknown): boolean {
  return ormErrorReason(error) === 'rejected-by-policy';
}
