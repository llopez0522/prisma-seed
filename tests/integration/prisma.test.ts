import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionError } from '../../src/core/errors.js';
import { disconnectPrisma, getPrismaClient, resetPrismaForTests } from '../../src/core/prisma.js';

/**
 * Verifica el cliente de Prisma contra la base real que levanta docker-compose.
 *
 * Es integracion y no unidad porque el objeto de la prueba es precisamente la
 * resolucion de `@prisma/client` desde el proyecto del usuario y la conexion.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureCwd = path.resolve(here, '../../.fixtures/pg-cjs');

afterEach(async () => {
  await disconnectPrisma();
  resetPrismaForTests();
});

describe('getPrismaClient', () => {
  it('resuelve el cliente desde el proyecto del usuario, no desde la libreria', () => {
    const prisma = getPrismaClient({ cwd: fixtureCwd });
    expect(prisma).toBeDefined();
    expect(typeof prisma.$queryRawUnsafe).toBe('function');
  });

  it('conecta y consulta la base real', async () => {
    const prisma = getPrismaClient({ cwd: fixtureCwd });
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>('SELECT 1 as ok');

    expect(rows[0]?.ok).toBe(1);
  });

  // B4/B12: la v0.2.4 creaba una instancia por modulo, mas una por cada seeder
  // generado. Aqui tiene que ser siempre la misma.
  it('devuelve siempre la misma instancia para el mismo cwd', () => {
    const a = getPrismaClient({ cwd: fixtureCwd });
    const b = getPrismaClient({ cwd: fixtureCwd });

    expect(a).toBe(b);
  });

  // B4: la v0.2.4 hacia process.exit(1) aqui, lo que impedia testearlo y mataba
  // el comando `generate`, que no necesita base de datos para nada.
  it('lanza ConnectionError en vez de matar el proceso si falta @prisma/client', () => {
    expect(() => getPrismaClient({ cwd: '/tmp' })).toThrow(ConnectionError);
  });

  it('el error incluye una pista accionable', () => {
    try {
      getPrismaClient({ cwd: '/tmp' });
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as ConnectionError).hint).toContain('npm install @prisma/client');
      expect((error as ConnectionError).exitCode).toBe(3);
    }
  });
});

describe('disconnectPrisma', () => {
  it('es idempotente y no falla si nunca se creo el cliente', async () => {
    resetPrismaForTests();
    await expect(disconnectPrisma()).resolves.toBeUndefined();
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it('cierra el cliente creado', async () => {
    getPrismaClient({ cwd: fixtureCwd });
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });
});
