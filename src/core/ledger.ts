import { isPolicyRejection, type Dialect } from './dialect/index.js';
import { CliError, EXIT, toMessage } from './errors.js';
import type { SeedClient, SeedExecutionRecord } from '../types.js';

/**
 * Registro de seeders ejecutados.
 *
 * Cambios de fondo respecto de la v0.2.4:
 *
 *  - **Todo el SQL viene del dialecto** (B1, B3). Nada de sintaxis Postgres
 *    incrustada en el codigo comun.
 *  - **`$executeRawUnsafe` para escrituras** (B2). En Postgres `$queryRawUnsafe`
 *    tambien funcionaba — lo verifique y mi diagnostico inicial era erroneo — pero
 *    la API correcta para INSERT/DELETE devuelve el numero de filas afectadas, que
 *    aqui se usa para detectar rollbacks que no encontraron nada.
 *  - **Columna `batch`** (B6). El orden de reversion pasa a `batch DESC, id DESC`,
 *    determinista incluso para seeders ejecutados en el mismo segundo. La fase 0
 *    demostro que `executedAt` empata: dos inserciones seguidas compartian valor.
 *  - **Deteccion de tabla ausente por codigo nativo** (B14). Prisma marca todo
 *    error de raw query como P2010, asi que el codigo de Prisma no discrimina.
 */

export interface LedgerOptions {
  /**
   * El cliente compartido. Solo se le piden `$queryRawUnsafe` y
   * `$executeRawUnsafe`, que Prisma y ZenStack v3 exponen igual.
   */
  prisma: SeedClient;
  dialect: Dialect;
  table: string;
}

/** Fila cruda tal como la devuelve el motor. */
interface RawRow {
  id: number | bigint;
  seedName: string;
  batch: number | bigint;
  executedAt: Date | string;
}

function toRecord(row: RawRow): SeedExecutionRecord {
  return {
    id: Number(row.id),
    seedName: row.seedName,
    batch: Number(row.batch),
    executedAt: row.executedAt instanceof Date ? row.executedAt : new Date(row.executedAt),
  };
}

export class Ledger {
  private readonly prisma: SeedClient;
  private readonly dialect: Dialect;
  private readonly table: string;

  constructor({ prisma, dialect, table }: LedgerOptions) {
    this.prisma = prisma;
    this.dialect = dialect;
    this.table = table;
  }

  private get t(): string {
    return this.dialect.quote(this.table);
  }

  private col(name: string): string {
    return this.dialect.quote(name);
  }

  private p(n: number): string {
    return this.dialect.placeholder(n);
  }

  /**
   * Crea la tabla si falta y la migra si viene de la v0.2.4.
   *
   * El caso de migracion importa: quien siguiera el README de la v0.2.4 tiene un
   * modelo `SeedExecution` declarado en su schema.prisma, sin columna `batch`. No
   * se puede recrear la tabla (perderia el historico), asi que se anade la columna
   * con DEFAULT 1: todo lo ya ejecutado queda en el batch 1.
   */
  async ensureTable(): Promise<{ created: boolean; migrated: boolean }> {
    const existedBefore = await this.tableExists();

    await this.prisma.$executeRawUnsafe(this.dialect.createLedgerTable(this.table));

    if (!existedBefore) return { created: true, migrated: false };

    const hasBatch = await this.hasBatchColumn();
    if (hasBatch) return { created: false, migrated: false };

    await this.prisma.$executeRawUnsafe(this.dialect.addBatchColumn(this.table));
    return { created: false, migrated: true };
  }

  async tableExists(): Promise<boolean> {
    try {
      await this.prisma.$queryRawUnsafe(`SELECT ${this.col('id')} FROM ${this.t} WHERE 1 = 0`);
      return true;
    } catch (error) {
      // B14: solo se interpreta como "no existe" si el motor lo dice con su
      // propio codigo. Cualquier otro error (permisos, conexion, columna
      // ausente) se propaga en vez de disfrazarse de tabla faltante.
      if (this.dialect.isMissingTableError(error)) return false;

      // ZenStack v3 con PolicyPlugin bloquea el SQL crudo por defecto. Sin este
      // caso, el fallo se lee como un problema de conexion y despista.
      if (isPolicyRejection(error)) {
        throw new CliError(
          `Una politica de acceso bloqueo la consulta del ledger "${this.table}": ${toMessage(error)}`,
          EXIT.CONNECTION,
          'ZenStack v3 rechaza $queryRaw/$executeRaw cuando el plugin de politicas ' +
            'esta instalado. Inyecta en seeder.config el cliente sin PolicyPlugin, o ' +
            'instalalo con new PolicyPlugin({ dangerouslyAllowRawSql: true }).'
        );
      }

      throw new CliError(
        `No se pudo consultar la tabla "${this.table}": ${toMessage(error)}`,
        EXIT.CONNECTION
      );
    }
  }

  private async hasBatchColumn(): Promise<boolean> {
    const { sql, params } = this.dialect.columnExists(this.table, 'batch');
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(sql, ...params);
    return Array.isArray(rows) && rows.length > 0;
  }

  /** Nombres de todos los seeders ya aplicados. */
  async appliedNames(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRawUnsafe<{ seedName: string }[]>(
      `SELECT ${this.col('seedName')} FROM ${this.t}`
    );
    return new Set(rows.map((r) => r.seedName));
  }

  /** Todos los registros, del mas reciente al mas antiguo. */
  async all(): Promise<SeedExecutionRecord[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT ${this.col('id')}, ${this.col('seedName')}, ${this.col('batch')}, ${this.col('executedAt')}
       FROM ${this.t}
       ORDER BY ${this.col('batch')} DESC, ${this.col('id')} DESC`
    );
    return rows.map(toRecord);
  }

  /** Registros de un batch concreto, en orden inverso al de ejecucion. */
  async byBatch(batch: number): Promise<SeedExecutionRecord[]> {
    const rows = await this.prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT ${this.col('id')}, ${this.col('seedName')}, ${this.col('batch')}, ${this.col('executedAt')}
       FROM ${this.t}
       WHERE ${this.col('batch')} = ${this.p(1)}
       ORDER BY ${this.col('id')} DESC`,
      batch
    );
    return rows.map(toRecord);
  }

  /** Numero del ultimo batch ejecutado, o 0 si el ledger esta vacio. */
  async lastBatch(): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ maxBatch: number | bigint | null }[]>(
      `SELECT MAX(${this.col('batch')}) AS ${this.col('maxBatch')} FROM ${this.t}`
    );
    const value = rows[0]?.maxBatch;
    return value === null || value === undefined ? 0 : Number(value);
  }

  /** Numero que corresponde al proximo batch. */
  async nextBatch(): Promise<number> {
    return (await this.lastBatch()) + 1;
  }

  /**
   * Registra un seeder como ejecutado.
   *
   * Acepta un cliente alternativo para poder participar en la transaccion que
   * envuelve al propio seeder (B7): si el seeder se aplica pero su registro no se
   * escribe, la siguiente ejecucion lo repetiria.
   */
  async record(seedName: string, batch: number, client: SeedClient = this.prisma): Promise<void> {
    await client.$executeRawUnsafe(
      `INSERT INTO ${this.t} (${this.col('seedName')}, ${this.col('batch')})
       VALUES (${this.p(1)}, ${this.p(2)})`,
      seedName,
      batch
    );
  }

  /** Borra el registro de un seeder. Devuelve si existia. */
  async remove(seedName: string, client: SeedClient = this.prisma): Promise<boolean> {
    const affected = await client.$executeRawUnsafe(
      `DELETE FROM ${this.t} WHERE ${this.col('seedName')} = ${this.p(1)}`,
      seedName
    );
    return affected > 0;
  }

  /** Vacia el ledger por completo. */
  async clear(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`DELETE FROM ${this.t}`);
  }
}
