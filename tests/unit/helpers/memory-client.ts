import type { SeedClient, SeedTransactionOptions } from '../../../src/types.js';

/**
 * Ledger en memoria con la interfaz de un cliente real.
 *
 * Implementa exactamente las sentencias que emite `core/ledger.ts` con el
 * dialecto de SQLite. No pretende ser un motor SQL: es un doble que permite
 * ejercitar el runner completo — descubrimiento, transaccion, registro, batches,
 * rollback — sin levantar una base de datos, y comprobar de paso **con que
 * argumentos** se llama a `$transaction`.
 *
 * El camino contra bases reales lo cubre `tests/integration/`.
 */

export interface LedgerRow {
  id: number;
  seedName: string;
  batch: number;
  executedAt: Date;
}

export interface MemoryClientOptions {
  /**
   * Superficie que imita. Solo cambia la FORMA del objeto y de sus errores, que
   * es lo que permite comprobar que la libreria funciona igual con las dos.
   */
  surface?: 'prisma' | 'alt';
  /** Empezar con la tabla ya creada, sin la columna `batch` (ledger v0.2.4). */
  legacyTable?: boolean;
}

export interface MemoryClient extends SeedClient {
  rows: LedgerRow[];
  tableCreated: boolean;
  hasBatchColumn: boolean;
  /** Argumentos con los que se ha invocado `$transaction`. */
  transactionArgCounts: number[];
  transactionOptions: unknown[];
  disconnected: number;
  /** Toda sentencia ejecutada, en orden. Util para depurar un fallo. */
  statements: string[];
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export function createMemoryClient(options: MemoryClientOptions = {}): MemoryClient {
  const client: MemoryClient = {
    rows: [],
    tableCreated: options.legacyTable === true,
    hasBatchColumn: options.legacyTable !== true,
    transactionArgCounts: [],
    transactionOptions: [],
    disconnected: 0,
    statements: [],

    $queryRawUnsafe: <T>(query: string, ...params: unknown[]): Promise<T> =>
      Promise.resolve(query_(query, params) as T),

    $executeRawUnsafe: (query: string, ...params: unknown[]): Promise<number> =>
      Promise.resolve(execute_(query, params)),

    $disconnect: (): Promise<void> => {
      client.disconnected += 1;
      return Promise.resolve();
    },

    $transaction: <R>(
      fn: (tx: SeedClient) => Promise<R>,
      txOptions?: SeedTransactionOptions
    ): Promise<R> => {
      client.transactionArgCounts.push(txOptions === undefined ? 1 : 2);
      client.transactionOptions.push(txOptions);

      const snapshot = client.rows.map((r) => ({ ...r }));

      return fn(client).catch((error: unknown) => {
        // Rollback: el objeto de la prueba es que un fallo a mitad no deje el
        // seeder registrado (B7).
        client.rows = snapshot;
        throw error;
      });
    },
  };

  let nextId = 1;

  function query_(rawSql: string, params: unknown[]): unknown {
    const sql = norm(rawSql);
    client.statements.push(sql);

    // tableExists()
    if (/^SELECT "id" FROM ".+" WHERE 1 = 0$/.test(sql)) {
      if (!client.tableCreated) throw missingTable(options.surface);
      return [];
    }

    // hasBatchColumn()
    if (sql.startsWith('SELECT name FROM pragma_table_info')) {
      const column = params[1];
      return column === 'batch' && client.hasBatchColumn ? [{ name: 'batch' }] : [];
    }

    // appliedNames()
    if (/^SELECT "seedName" FROM/.test(sql)) {
      requireTable();
      return client.rows.map((r) => ({ seedName: r.seedName }));
    }

    // lastBatch()
    if (sql.includes('MAX("batch")')) {
      requireTable();
      const max = client.rows.reduce((acc, r) => Math.max(acc, r.batch), 0);
      return [{ maxBatch: client.rows.length === 0 ? null : max }];
    }

    // byBatch()
    if (sql.includes('WHERE "batch" =')) {
      requireTable();
      const batch = Number(params[0]);
      return client.rows
        .filter((r) => r.batch === batch)
        .sort((a, b) => b.id - a.id)
        .map((r) => ({ ...r }));
    }

    // all()
    if (sql.startsWith('SELECT "id", "seedName", "batch", "executedAt"')) {
      requireTable();
      return [...client.rows]
        .sort((a, b) => (b.batch === a.batch ? b.id - a.id : b.batch - a.batch))
        .map((r) => ({ ...r }));
    }

    throw new Error(`El doble en memoria no reconoce la consulta: ${sql}`);
  }

  function execute_(rawSql: string, params: unknown[]): number {
    const sql = norm(rawSql);
    client.statements.push(sql);

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
      if (!client.tableCreated) {
        client.tableCreated = true;
        client.hasBatchColumn = true;
      }
      return 0;
    }

    if (sql.includes('ADD COLUMN "batch"')) {
      client.hasBatchColumn = true;
      for (const row of client.rows) row.batch = 1;
      return 0;
    }

    if (sql.startsWith('INSERT INTO')) {
      requireTable();
      const seedName = String(params[0]);
      if (client.rows.some((r) => r.seedName === seedName)) {
        throw new Error(`UNIQUE constraint failed: ${seedName}`);
      }
      client.rows.push({
        id: nextId++,
        seedName,
        batch: Number(params[1]),
        executedAt: new Date(),
      });
      return 1;
    }

    if (sql.startsWith('DELETE FROM') && sql.includes('WHERE "seedName" =')) {
      requireTable();
      const before = client.rows.length;
      client.rows = client.rows.filter((r) => r.seedName !== params[0]);
      return before - client.rows.length;
    }

    if (sql.startsWith('DELETE FROM')) {
      requireTable();
      const before = client.rows.length;
      client.rows = [];
      return before;
    }

    throw new Error(`El doble en memoria no reconoce la sentencia: ${sql}`);
  }

  function requireTable(): void {
    if (!client.tableCreated) throw missingTable(options.surface);
  }

  if (options.surface === 'alt') {
    // Superficie de un cliente que no es Prisma (tomada de ZenStackClient) y
    // errores con su misma forma: `reason` + `dbErrorCode`/`dbErrorMessage`.
    return Object.assign(client, {
      $qb: {},
      $schema: { provider: 'sqlite' },
      $setAuth: () => client,
    });
  }

  return Object.assign(client, { $extends: () => client, $on: () => undefined });
}

/**
 * Error de "tabla ausente" con la forma que le da cada cliente.
 *
 * Prisma lo entrega como P2010 con el detalle del motor en `meta`; otros ORMs
 * (medido en ZenStack 3.9.1) como un error con `reason` y `dbErrorMessage`. Que
 * los dos se reconozcan es justo lo que verifica el doble.
 */
function missingTable(surface: MemoryClientOptions['surface']): Error {
  if (surface === 'alt') {
    return Object.assign(new Error('query failed'), {
      reason: 'db-query-error',
      dbErrorCode: '1',
      dbErrorMessage: 'no such table: SeedExecution',
    });
  }

  return Object.assign(new Error('raw query failed'), {
    code: 'P2010',
    meta: { code: '1', message: 'no such table: SeedExecution' },
  });
}
