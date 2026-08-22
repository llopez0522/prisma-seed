import { type Dialect, matchesNativeCode } from './types.js';

/** SQL Server: `Invalid object name`. */
const MISSING_TABLE_CODES = ['208'] as const;

export const sqlserverDialect: Dialect = {
  name: 'sqlserver',

  quote(identifier) {
    return `[${identifier.replace(/]/g, ']]')}]`;
  },

  placeholder(n) {
    return `@P${n}`;
  },

  /** SQL Server no tiene `CREATE TABLE IF NOT EXISTS`: hay que comprobarlo antes. */
  createLedgerTable(table) {
    const t = this.quote(table);
    return `IF OBJECT_ID(N'${table.replace(/'/g, "''")}', N'U') IS NULL
CREATE TABLE ${t} (
  ${this.quote('id')} INT IDENTITY(1,1) PRIMARY KEY,
  ${this.quote('seedName')} NVARCHAR(255) NOT NULL UNIQUE,
  ${this.quote('batch')} INT NOT NULL DEFAULT 1,
  ${this.quote('executedAt')} DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)`;
  },

  columnExists(table, column) {
    return {
      sql: `SELECT column_name FROM information_schema.columns
            WHERE table_name = @P1 AND column_name = @P2`,
      params: [table, column],
    };
  },

  addBatchColumn(table) {
    return `ALTER TABLE ${this.quote(table)} ADD ${this.quote('batch')} INT NOT NULL DEFAULT 1`;
  },

  isMissingTableError(error) {
    return matchesNativeCode(error, MISSING_TABLE_CODES);
  },

  listTables() {
    return {
      sql: `SELECT table_name AS name FROM information_schema.tables
            WHERE table_type = 'BASE TABLE'
            ORDER BY table_name`,
      params: [],
    };
  },

  /**
   * TRUNCATE falla sobre tablas referenciadas por claves ajenas, y a diferencia de
   * MySQL no hay un interruptor global: hay que desactivar las restricciones tabla
   * por tabla. `DBCC CHECKIDENT ... RESEED, 0` es lo que resetea el IDENTITY.
   */
  truncateAll(tables) {
    if (tables.length === 0) return [];
    return [
      ...tables.map((t) => ({ sql: `ALTER TABLE ${this.quote(t)} NOCHECK CONSTRAINT ALL` })),
      ...tables.map((t) => ({ sql: `DELETE FROM ${this.quote(t)}` })),
      // Solo tiene sentido en tablas con IDENTITY; en las demas DBCC avisa y
      // sigue, asi que se marca de mejor esfuerzo.
      ...tables.map((t) => ({
        sql: `DBCC CHECKIDENT ('${t.replace(/'/g, "''")}', RESEED, 0)`,
        optional: true,
      })),
      ...tables.map((t) => ({
        sql: `ALTER TABLE ${this.quote(t)} WITH CHECK CHECK CONSTRAINT ALL`,
      })),
    ];
  },
};
