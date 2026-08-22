import { type Dialect, matchesNativeCode } from './types.js';

/**
 * MySQL identifica el mismo fallo de tres formas segun el cliente que lo reporte:
 * el numero de error (`1146`), el nombre simbolico de mysql2
 * (`ER_NO_SUCH_TABLE`) y el SQLSTATE (`42S02`). Se aceptan todas para que la
 * deteccion funcione tanto con Prisma como con un driver de Kysely.
 */
const MISSING_TABLE_CODES = [
  '1146',
  '1051',
  'ER_NO_SUCH_TABLE',
  'ER_BAD_TABLE_ERROR',
  '42S02',
] as const;

export const mysqlDialect: Dialect = {
  name: 'mysql',

  /**
   * B3, causa raiz del fallo total en MySQL: con el `sql_mode` por defecto, las
   * comillas dobles delimitan *cadenas*, no identificadores. Por eso las 4
   * sentencias de la v0.2.4 fallaban con error 1064, incluida la que usaba el
   * placeholder `?` correcto. El delimitador de identificadores es el acento
   * grave.
   */
  quote(identifier) {
    return `\`${identifier.replace(/`/g, '``')}\``;
  },

  placeholder() {
    return '?';
  },

  createLedgerTable(table) {
    const t = this.quote(table);
    return `CREATE TABLE IF NOT EXISTS ${t} (
  ${this.quote('id')} INT AUTO_INCREMENT PRIMARY KEY,
  ${this.quote('seedName')} VARCHAR(255) NOT NULL UNIQUE,
  ${this.quote('batch')} INT NOT NULL DEFAULT 1,
  ${this.quote('executedAt')} DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)`;
  },

  columnExists(table, column) {
    return {
      sql: `SELECT column_name FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      params: [table, column],
    };
  },

  addBatchColumn(table) {
    return `ALTER TABLE ${this.quote(table)} ADD COLUMN ${this.quote('batch')} INT NOT NULL DEFAULT 1`;
  },

  isMissingTableError(error) {
    return matchesNativeCode(error, MISSING_TABLE_CODES);
  },

  listTables() {
    return {
      sql: `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
            ORDER BY table_name`,
      params: [],
    };
  },

  /**
   * MySQL no admite TRUNCATE sobre una tabla referenciada por una clave ajena,
   * asi que hay que desactivar la comprobacion durante la operacion. TRUNCATE ya
   * resetea AUTO_INCREMENT por si mismo.
   */
  truncateAll(tables) {
    if (tables.length === 0) return [];
    return [
      { sql: 'SET FOREIGN_KEY_CHECKS = 0' },
      ...tables.map((t) => ({ sql: `TRUNCATE TABLE ${this.quote(t)}` })),
      { sql: 'SET FOREIGN_KEY_CHECKS = 1' },
    ];
  },
};
