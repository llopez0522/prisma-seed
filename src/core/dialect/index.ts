import { mysqlDialect } from './mysql.js';
import { postgresDialect } from './postgres.js';
import { sqliteDialect } from './sqlite.js';
import { sqlserverDialect } from './sqlserver.js';
import type { Dialect } from './types.js';
import type { Provider } from '../../types.js';

const DIALECTS: Record<Provider, Dialect> = {
  postgresql: postgresDialect,
  mysql: mysqlDialect,
  sqlite: sqliteDialect,
  sqlserver: sqlserverDialect,
};

/** Devuelve el dialecto del motor indicado. */
export function getDialect(provider: Provider): Dialect {
  return DIALECTS[provider];
}

export {
  isPolicyRejection,
  LEDGER_COLUMNS,
  matchesNativeCode,
  nativeErrorCode,
  nativeErrorCodes,
  nativeErrorMessage,
  ormErrorReason,
} from './types.js';
export type { Dialect, TruncateStatement } from './types.js';
export { mysqlDialect, postgresDialect, sqliteDialect, sqlserverDialect };
