import { describe, expect, it } from 'vitest';

import {
  getDialect,
  isPolicyRejection,
  mysqlDialect,
  nativeErrorCode,
  nativeErrorCodes,
  ormErrorReason,
  postgresDialect,
  sqliteDialect,
  sqlserverDialect,
} from '../../src/core/dialect/index.js';
import type { Dialect } from '../../src/core/dialect/index.js';

const todos: [string, Dialect][] = [
  ['postgresql', postgresDialect],
  ['mysql', mysqlDialect],
  ['sqlite', sqliteDialect],
  ['sqlserver', sqlserverDialect],
];

describe('getDialect', () => {
  it('devuelve el dialecto de cada motor soportado', () => {
    expect(getDialect('postgresql').name).toBe('postgresql');
    expect(getDialect('mysql').name).toBe('mysql');
    expect(getDialect('sqlite').name).toBe('sqlite');
    expect(getDialect('sqlserver').name).toBe('sqlserver');
  });
});

describe('entrecomillado de identificadores', () => {
  it('usa el delimitador propio de cada motor', () => {
    expect(postgresDialect.quote('SeedExecution')).toBe('"SeedExecution"');
    expect(sqliteDialect.quote('SeedExecution')).toBe('"SeedExecution"');
    expect(sqlserverDialect.quote('SeedExecution')).toBe('[SeedExecution]');
  });

  // Causa raiz del fallo total en MySQL: con el sql_mode por defecto, las
  // comillas dobles delimitan cadenas, no identificadores.
  it('MySQL usa acento grave, no comillas dobles', () => {
    expect(mysqlDialect.quote('SeedExecution')).toBe('`SeedExecution`');
    expect(mysqlDialect.quote('SeedExecution')).not.toContain('"');
  });

  it('escapa el propio delimitador para evitar inyeccion', () => {
    expect(postgresDialect.quote('a"b')).toBe('"a""b"');
    expect(mysqlDialect.quote('a`b')).toBe('`a``b`');
    expect(sqlserverDialect.quote('a]b')).toBe('[a]]b]');
  });
});

describe('placeholders', () => {
  it('Postgres usa posicionales numerados', () => {
    expect(postgresDialect.placeholder(1)).toBe('$1');
    expect(postgresDialect.placeholder(2)).toBe('$2');
  });

  it('MySQL y SQLite usan interrogante', () => {
    expect(mysqlDialect.placeholder(1)).toBe('?');
    expect(mysqlDialect.placeholder(2)).toBe('?');
    expect(sqliteDialect.placeholder(1)).toBe('?');
  });

  it('SQL Server usa @P numerados', () => {
    expect(sqlserverDialect.placeholder(1)).toBe('@P1');
    expect(sqlserverDialect.placeholder(2)).toBe('@P2');
  });
});

describe('DDL del ledger', () => {
  it.each(todos)('%s declara las cuatro columnas', (_nombre, dialect) => {
    const ddl = dialect.createLedgerTable('SeedExecution');

    for (const col of ['id', 'seedName', 'batch', 'executedAt']) {
      expect(ddl).toContain(dialect.quote(col));
    }
  });

  // B1: la v0.2.4 dejaba seedName y executedAt SIN entrecomillar, asi que
  // Postgres los plegaba a minusculas y las consultas no los encontraban.
  it('Postgres entrecomilla TODAS las columnas, no solo la tabla', () => {
    const ddl = postgresDialect.createLedgerTable('SeedExecution');

    expect(ddl).toContain('"seedName"');
    expect(ddl).toContain('"executedAt"');
    // La forma sin comillas de la v0.2.4 no debe aparecer.
    expect(ddl).not.toMatch(/\bseedName VARCHAR/);
  });

  // B3, caso silencioso: SERIAL no es alias de rowid en SQLite y deja el id a NULL.
  it('SQLite usa INTEGER PRIMARY KEY AUTOINCREMENT, nunca SERIAL', () => {
    const ddl = sqliteDialect.createLedgerTable('SeedExecution');

    expect(ddl).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(ddl).not.toContain('SERIAL');
  });

  it('MySQL usa AUTO_INCREMENT y no SERIAL', () => {
    const ddl = mysqlDialect.createLedgerTable('SeedExecution');

    expect(ddl).toContain('AUTO_INCREMENT');
    expect(ddl).not.toMatch(/\bSERIAL\b/);
  });

  it('SQL Server usa IDENTITY y comprueba la existencia antes de crear', () => {
    const ddl = sqlserverDialect.createLedgerTable('SeedExecution');

    expect(ddl).toContain('IDENTITY(1,1)');
    expect(ddl).toContain('OBJECT_ID');
  });

  it.each(todos)('%s declara batch con DEFAULT 1 para migrar ledgers antiguos', (_n, dialect) => {
    expect(dialect.createLedgerTable('SeedExecution')).toMatch(/DEFAULT 1/);
  });
});

describe('deteccion de tabla ausente (B14)', () => {
  // Prisma marca TODO error de raw query como P2010 y expone el codigo nativo
  // del motor en meta.code. Verificado en fase 0: 42P01 (tabla) y 42703
  // (columna) llegan ambos como P2010.
  function prismaError(nativeCode: string, message = ''): unknown {
    return { code: 'P2010', meta: { code: nativeCode, message } };
  }

  it('Postgres reconoce 42P01 y NO confunde 42703 (columna ausente)', () => {
    expect(postgresDialect.isMissingTableError(prismaError('42P01'))).toBe(true);
    expect(postgresDialect.isMissingTableError(prismaError('42703'))).toBe(false);
  });

  it('MySQL reconoce 1146', () => {
    expect(mysqlDialect.isMissingTableError(prismaError('1146'))).toBe(true);
    expect(mysqlDialect.isMissingTableError(prismaError('1064'))).toBe(false);
  });

  // SQLite manda todo con codigo 1: hay que mirar el texto.
  it('SQLite discrimina por el mensaje, porque su codigo siempre es 1', () => {
    expect(sqliteDialect.isMissingTableError(prismaError('1', 'no such table: X'))).toBe(true);
    expect(sqliteDialect.isMissingTableError(prismaError('1', 'no such column: y'))).toBe(false);
  });

  it('SQL Server reconoce 208', () => {
    expect(sqlserverDialect.isMissingTableError(prismaError('208'))).toBe(true);
  });

  it.each(todos)('%s no confunde un error sin meta con tabla ausente', (_n, dialect) => {
    expect(dialect.isMissingTableError(new Error('conexion rechazada'))).toBe(false);
    expect(dialect.isMissingTableError(null)).toBe(false);
    expect(dialect.isMissingTableError(undefined)).toBe(false);
  });
});

describe('nativeErrorCode', () => {
  it('extrae el codigo del motor desde meta', () => {
    expect(nativeErrorCode({ code: 'P2010', meta: { code: '42P01' } })).toBe('42P01');
  });

  it('devuelve null cuando no hay codigo nativo', () => {
    expect(nativeErrorCode(new Error('x'))).toBeNull();
    expect(nativeErrorCode({ meta: {} })).toBeNull();
    expect(nativeErrorCode(null)).toBeNull();
  });
});

describe('truncateAll', () => {
  it('Postgres resetea las secuencias en una sola sentencia', () => {
    const [sql] = postgresDialect.truncateAll(['User', 'Post']).map((s) => s.sql);

    expect(sql).toContain('RESTART IDENTITY');
    expect(sql).toContain('CASCADE');
  });

  it('MySQL desactiva las claves ajenas alrededor de los TRUNCATE', () => {
    const sqls = mysqlDialect.truncateAll(['User', 'Post']).map((s) => s.sql);

    expect(sqls[0]).toContain('FOREIGN_KEY_CHECKS = 0');
    expect(sqls.at(-1)).toContain('FOREIGN_KEY_CHECKS = 1');
    expect(sqls.filter((s) => s.startsWith('TRUNCATE'))).toHaveLength(2);
  });

  it('SQLite borra ademas sqlite_sequence para resetear los autoincrementales', () => {
    const sqls = sqliteDialect.truncateAll(['User']).map((s) => s.sql);

    expect(sqls.some((s) => s.includes('sqlite_sequence'))).toBe(true);
    expect(sqls.some((s) => s.includes('TRUNCATE'))).toBe(false);
  });

  it('SQL Server hace RESEED del IDENTITY', () => {
    const sqls = sqlserverDialect.truncateAll(['User']).map((s) => s.sql);

    expect(sqls.some((s) => s.includes('RESEED'))).toBe(true);
  });

  it.each(todos)('%s devuelve lista vacia si no hay tablas', (_n, dialect) => {
    expect(dialect.truncateAll([])).toEqual([]);
  });
});

/**
 * ZenStack v3 no usa la envoltura de Prisma: lanza `ORMError` con el codigo del
 * driver en `dbErrorCode` y el texto en `dbErrorMessage` (`docs/orm/errors`), y a
 * veces solo queda el error del driver colgando de `cause`. La deteccion tiene
 * que funcionar igual en los tres casos o `run` fallaria contra una base recien
 * creada.
 */
describe('errores de ZenStack v3', () => {
  function ormError(fields: Record<string, unknown>): unknown {
    return Object.assign(new Error('ORM error'), fields);
  }

  it('lee el codigo nativo de dbErrorCode', () => {
    expect(nativeErrorCode(ormError({ reason: 'db-query-error', dbErrorCode: '42P01' }))).toBe(
      '42P01'
    );
  });

  it('Postgres reconoce la tabla ausente reportada por ZenStack', () => {
    const error = ormError({ reason: 'db-query-error', dbErrorCode: '42P01' });
    expect(postgresDialect.isMissingTableError(error)).toBe(true);
  });

  it('SQLite reconoce el texto que llega en dbErrorMessage', () => {
    const error = ormError({
      reason: 'db-query-error',
      dbErrorMessage: 'no such table: SeedExecution',
    });
    expect(sqliteDialect.isMissingTableError(error)).toBe(true);
  });

  it('encuentra el codigo del driver dentro de cause', () => {
    const driver = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const error = ormError({ reason: 'db-query-error', cause: driver });

    expect(postgresDialect.isMissingTableError(error)).toBe(true);
  });

  it('SQLite encuentra el texto dentro de cause', () => {
    const driver = new Error('SQLITE_ERROR: no such table: SeedExecution');
    const error = ormError({ reason: 'db-query-error', cause: driver });

    expect(sqliteDialect.isMissingTableError(error)).toBe(true);
  });

  // mysql2 identifica el mismo fallo con nombre simbolico y con errno.
  it('MySQL reconoce ER_NO_SUCH_TABLE y errno 1146', () => {
    const porNombre = Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' });
    const porErrno = Object.assign(new Error('x'), { errno: 1146 });

    expect(mysqlDialect.isMissingTableError(porNombre)).toBe(true);
    expect(mysqlDialect.isMissingTableError(porErrno)).toBe(true);
  });

  it('P2010 por si solo no se confunde con tabla ausente en ningun motor', () => {
    const error = { code: 'P2010', meta: {} };
    expect(postgresDialect.isMissingTableError(error)).toBe(false);
    expect(mysqlDialect.isMissingTableError(error)).toBe(false);
    expect(sqlserverDialect.isMissingTableError(error)).toBe(false);
  });

  it('no se cuelga con una cadena de cause circular', () => {
    const a: Record<string, unknown> = { reason: 'db-query-error' };
    const b: Record<string, unknown> = { cause: a };
    a['cause'] = b;

    expect(() => nativeErrorCode(a)).not.toThrow();
  });
});

describe('nativeErrorCodes', () => {
  it('devuelve todos los candidatos, con meta.code primero', () => {
    const codes = nativeErrorCodes({ code: 'P2010', meta: { code: '42P01' } });
    expect(codes[0]).toBe('42P01');
    expect(codes).toContain('P2010');
  });

  it('no duplica el mismo codigo visto en dos sitios', () => {
    const codes = nativeErrorCodes({ dbErrorCode: '1146', code: '1146' });
    expect(codes).toEqual(['1146']);
  });
});

describe('isPolicyRejection', () => {
  it('reconoce el rechazo por politica de ZenStack v3', () => {
    expect(isPolicyRejection({ reason: 'rejected-by-policy' })).toBe(true);
    expect(ormErrorReason({ reason: 'rejected-by-policy' })).toBe('rejected-by-policy');
  });

  it('no marca otros errores', () => {
    expect(isPolicyRejection({ reason: 'db-query-error' })).toBe(false);
    expect(isPolicyRejection(new Error('x'))).toBe(false);
    expect(isPolicyRejection(null)).toBe(false);
  });
});

describe('listTables', () => {
  it('Postgres se limita al esquema actual', () => {
    const { sql } = postgresDialect.listTables();
    expect(sql).toContain('pg_tables');
    expect(sql).toContain('current_schema()');
  });

  it('MySQL se limita a la base actual y a tablas base', () => {
    const { sql } = mysqlDialect.listTables();
    expect(sql).toContain('DATABASE()');
    expect(sql).toContain("table_type = 'BASE TABLE'");
  });

  // SQLite no tiene information_schema; y sus tablas internas llevan prefijo.
  it('SQLite lee sqlite_master y excluye las internas', () => {
    const { sql } = sqliteDialect.listTables();
    expect(sql).toContain('sqlite_master');
    expect(sql).toContain("name NOT LIKE 'sqlite_%'");
  });

  it('SQL Server se limita a tablas base', () => {
    const { sql } = sqlserverDialect.listTables();
    expect(sql).toContain("table_type = 'BASE TABLE'");
  });

  it.each(todos)('%s no necesita parametros', (_n, dialect) => {
    expect(dialect.listTables().params).toEqual([]);
  });
});

/**
 * B-nuevo: en SQLite `sqlite_sequence` se crea la primera vez que se declara una
 * tabla con AUTOINCREMENT. En una base que no tenga ninguna, sencillamente no
 * existe, y borrarla abortaria el vaciado entero.
 */
describe('sentencias de mejor esfuerzo en truncateAll', () => {
  it('SQLite marca el borrado de sqlite_sequence como opcional', () => {
    const secuencia = sqliteDialect
      .truncateAll(['User'])
      .find((s) => s.sql.includes('sqlite_sequence'));

    expect(secuencia?.optional).toBe(true);
  });

  it('el borrado de las tablas de verdad NO es opcional', () => {
    const borrado = sqliteDialect.truncateAll(['User']).find((s) => s.sql.includes('"User"'));
    expect(borrado?.optional).toBeUndefined();
  });

  it('Postgres no necesita ninguna sentencia opcional', () => {
    expect(postgresDialect.truncateAll(['User']).every((s) => s.optional !== true)).toBe(true);
  });
});
