import { type Dialect, nativeErrorMessage } from './types.js';

export const sqliteDialect: Dialect = {
  name: 'sqlite',

  quote(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
  },

  placeholder() {
    return '?';
  },

  /**
   * B3, el caso silencioso. SQLite acepta cualquier nombre de tipo por su sistema
   * de afinidad, asi que tolero el `SERIAL` de la v0.2.4 sin protestar — pero solo
   * `INTEGER PRIMARY KEY` es alias de rowid. Verificado en la fase 0: con `SERIAL`,
   * las dos filas insertadas quedaron con `id: null`, es decir, clave primaria
   * enteramente nula y nadie se entera.
   *
   * `AUTOINCREMENT` ademas impide reutilizar ids de filas borradas, que es lo que
   * se quiere en un ledger donde el id define el orden de rollback (B6).
   */
  createLedgerTable(table) {
    const t = this.quote(table);
    return `CREATE TABLE IF NOT EXISTS ${t} (
  ${this.quote('id')} INTEGER PRIMARY KEY AUTOINCREMENT,
  ${this.quote('seedName')} TEXT NOT NULL UNIQUE,
  ${this.quote('batch')} INTEGER NOT NULL DEFAULT 1,
  ${this.quote('executedAt')} DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
  },

  /**
   * SQLite no tiene information_schema. `PRAGMA table_info` devuelve una fila por
   * columna, asi que se filtra por nombre.
   */
  columnExists(table, column) {
    return {
      sql: `SELECT name FROM pragma_table_info(?) WHERE name = ?`,
      params: [table, column],
    };
  },

  addBatchColumn(table) {
    return `ALTER TABLE ${this.quote(table)} ADD COLUMN ${this.quote('batch')} INTEGER NOT NULL DEFAULT 1`;
  },

  /**
   * SQLite no expone codigos de error granulares: todo llega como `1`. Hay que
   * mirar el texto. Es fragil por naturaleza, pero es lo unico que da el motor.
   */
  isMissingTableError(error) {
    return /no such table/i.test(nativeErrorMessage(error));
  },

  /**
   * SQLite no tiene information_schema. `sqlite_master` es el catalogo, y sus
   * propias tablas internas llevan el prefijo `sqlite_`.
   */
  listTables() {
    return {
      sql: `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
      params: [],
    };
  },

  /**
   * SQLite no tiene TRUNCATE. `DELETE FROM` sin WHERE es el equivalente, y para
   * resetear los autoincrementales hay que vaciar `sqlite_sequence`, que es donde
   * se guarda el ultimo rowid por tabla.
   */
  truncateAll(tables) {
    if (tables.length === 0) return [];
    return [
      { sql: 'PRAGMA foreign_keys = OFF' },
      ...tables.map((t) => ({ sql: `DELETE FROM ${this.quote(t)}` })),
      // `optional`: sqlite_sequence solo existe si alguna tabla se declaro con
      // AUTOINCREMENT. Sin ninguna, no esta, y eso no es un fallo.
      { sql: `DELETE FROM sqlite_sequence`, optional: true },
      { sql: 'PRAGMA foreign_keys = ON' },
    ];
  },
};
