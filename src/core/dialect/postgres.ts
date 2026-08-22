import { type Dialect, matchesNativeCode } from './types.js';

/** Postgres: `relation "x" does not exist`. */
const MISSING_TABLE_CODES = ['42P01'] as const;

export const postgresDialect: Dialect = {
  name: 'postgresql',

  quote(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  },

  placeholder(n) {
    return `$${n}`;
  },

  /**
   * B1: la v0.2.4 escribia `seedName VARCHAR(255)` SIN entrecomillar dentro de un
   * CREATE TABLE cuyo nombre de tabla SI estaba entrecomillado. Postgres pliega a
   * minusculas todo identificador no entrecomillado, asi que la columna nacia como
   * `seedname` mientras las consultas pedian `"seedName"`. Resultado verificado:
   * `42703 column "seedName" does not exist`. Aqui se entrecomilla todo.
   */
  createLedgerTable(table) {
    const t = this.quote(table);
    return `CREATE TABLE IF NOT EXISTS ${t} (
  ${this.quote('id')} SERIAL PRIMARY KEY,
  ${this.quote('seedName')} VARCHAR(255) NOT NULL UNIQUE,
  ${this.quote('batch')} INTEGER NOT NULL DEFAULT 1,
  ${this.quote('executedAt')} TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
  },

  columnExists(table, column) {
    return {
      sql: `SELECT column_name FROM information_schema.columns
            WHERE table_name = $1 AND column_name = $2`,
      params: [table, column],
    };
  },

  addBatchColumn(table) {
    return `ALTER TABLE ${this.quote(table)} ADD COLUMN ${this.quote('batch')} INTEGER NOT NULL DEFAULT 1`;
  },

  isMissingTableError(error) {
    return matchesNativeCode(error, MISSING_TABLE_CODES);
  },

  listTables() {
    return {
      sql: `SELECT tablename AS name FROM pg_tables
            WHERE schemaname = current_schema()
            ORDER BY tablename`,
      params: [],
    };
  },

  /**
   * `RESTART IDENTITY` resetea las secuencias; `CASCADE` salva las claves ajenas.
   * Un solo TRUNCATE con todas las tablas evita problemas de orden.
   */
  truncateAll(tables) {
    if (tables.length === 0) return [];
    const list = tables.map((t) => this.quote(t)).join(', ');
    return [{ sql: `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE` }];
  },
};
