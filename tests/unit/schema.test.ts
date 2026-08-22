import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../../src/core/errors.js';
import { parseProvider, readProvider } from '../../src/core/schema.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function schema(provider: string): string {
  return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}

model User {
  id Int @id @default(autoincrement())
}`;
}

describe('parseProvider', () => {
  it('extrae cada motor soportado', () => {
    expect(parseProvider(schema('postgresql'))).toBe('postgresql');
    expect(parseProvider(schema('mysql'))).toBe('mysql');
    expect(parseProvider(schema('sqlite'))).toBe('sqlite');
    expect(parseProvider(schema('sqlserver'))).toBe('sqlserver');
  });

  it('normaliza el alias postgres a postgresql', () => {
    expect(parseProvider(schema('postgres'))).toBe('postgresql');
  });

  // El bloque generator tambien tiene un campo "provider": no debe confundirlos.
  it('lee el provider del datasource, no el del generator', () => {
    expect(parseProvider(schema('mysql'))).toBe('mysql');
  });

  it('devuelve null para motores no soportados', () => {
    expect(parseProvider(schema('mongodb'))).toBeNull();
    expect(parseProvider(schema('cockroachdb'))).toBeNull();
  });

  it('devuelve null si no hay bloque datasource', () => {
    expect(parseProvider('model User { id Int @id }')).toBeNull();
  });

  it('tolera espaciado y nombres de datasource distintos', () => {
    const raro = `datasource   miBase   {
        provider="sqlite"
        url = env("DATABASE_URL")
    }`;
    expect(parseProvider(raro)).toBe('sqlite');
  });
});

describe('readProvider', () => {
  it('lee el provider desde el archivo', () => {
    const file = path.join(dir, 'schema.prisma');
    fs.writeFileSync(file, schema('postgresql'));

    expect(readProvider(file)).toBe('postgresql');
  });

  it('lanza con ruta concreta si el schema no existe', () => {
    expect(() => readProvider(path.join(dir, 'no-existe.prisma'))).toThrow(CliError);
    expect(() => readProvider(path.join(dir, 'no-existe.prisma'))).toThrow(/no-existe\.prisma/);
  });

  // Adivinar Postgres en silencio es exactamente lo que causo B3.
  it('lanza en vez de adivinar cuando el motor no se reconoce', () => {
    const file = path.join(dir, 'schema.prisma');
    fs.writeFileSync(file, schema('mongodb'));

    expect(() => readProvider(file)).toThrow(CliError);
    expect(() => readProvider(file)).toThrow(/provider/i);
  });
});

/**
 * ZModel (ZenStack v3) declara el mismo bloque `datasource` que Prisma, pero sus
 * ejemplos canonicos usan comillas simples
 * (https://zenstack.dev/docs/reference/zmodel/datasource). El parseo tiene que
 * cubrir los dos ecosistemas con el mismo codigo.
 */
describe('schema de ZenStack v3 (.zmodel)', () => {
  function zmodel(provider: string, quote = "'"): string {
    return `datasource db {
    provider = ${quote}${provider}${quote}
    url      = env('DATABASE_URL')
}

model User {
    id Int @id @default(autoincrement())
    @@allow('read', true)
}`;
  }

  it('lee el provider entre comillas simples', () => {
    expect(parseProvider(zmodel('postgresql'))).toBe('postgresql');
    expect(parseProvider(zmodel('mysql'))).toBe('mysql');
    expect(parseProvider(zmodel('sqlite'))).toBe('sqlite');
  });

  it('lee el provider entre comillas dobles en un .zmodel', () => {
    expect(parseProvider(zmodel('postgresql', '"'))).toBe('postgresql');
  });

  it('readProvider funciona sobre un archivo .zmodel', () => {
    const file = path.join(dir, 'schema.zmodel');
    fs.writeFileSync(file, zmodel('sqlite'));

    expect(readProvider(file)).toBe('sqlite');
  });

  it('el error de schema ausente menciona los dos formatos', () => {
    try {
      readProvider(path.join(dir, 'no-existe.zmodel'));
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect((error as CliError).hint).toContain('zenstack/schema.zmodel');
    }
  });
});
