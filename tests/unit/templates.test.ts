import { describe, expect, it } from 'vitest';

import { extensionFor, renderTemplate } from '../../src/templates/seeder.js';

const flavors = ['esm', 'cjs', 'ts'] as const;

describe('renderTemplate', () => {
  it.each(flavors)('%s exporta main y down', (flavor) => {
    const code = renderTemplate(flavor, { name: 'User' });

    expect(code).toMatch(/\bmain\b/);
    expect(code).toMatch(/\bdown\b/);
  });

  it('ESM usa export, CJS usa module.exports', () => {
    expect(renderTemplate('esm', { name: 'User' })).toContain('export async function main');
    expect(renderTemplate('cjs', { name: 'User' })).toContain('module.exports = { main, down }');
    expect(renderTemplate('cjs', { name: 'User' })).not.toContain('export async function');
  });

  it('la plantilla TypeScript tipa el contexto con el cliente generado', () => {
    const code = renderTemplate('ts', { name: 'User' });

    expect(code).toContain("import type { PrismaClient } from '@prisma/client'");
    expect(code).toContain('SeedContext<PrismaClient>');
  });

  // B9 en la plantilla generada.
  it.each(flavors)('%s usa el accesor camelCase del modelo', (flavor) => {
    const code = renderTemplate(flavor, { name: 'UserProfile' });

    expect(code).toContain('prisma.userProfile');
    expect(code).not.toContain('prisma.userprofile');
  });

  /**
   * B12: cada seeder generado por la v0.2.4 hacia su propio `new PrismaClient()`
   * y ninguno se desconectaba. Ahora el cliente llega inyectado.
   */
  it.each(flavors)('%s NO instancia su propio PrismaClient', (flavor) => {
    const code = renderTemplate(flavor, { name: 'User' });

    expect(code).not.toContain('new PrismaClient()');
    expect(code).toContain('{ prisma, logger }');
  });

  it('permite apuntar a un modelo distinto del nombre del seeder', () => {
    const code = renderTemplate('esm', { name: 'DatosIniciales', model: 'UserProfile' });

    expect(code).toContain('prisma.userProfile');
  });
});

describe('extensionFor', () => {
  it('devuelve .ts solo para TypeScript', () => {
    expect(extensionFor('ts')).toBe('.ts');
    expect(extensionFor('esm')).toBe('.js');
    expect(extensionFor('cjs')).toBe('.js');
  });
});

/**
 * La plantilla TypeScript importaba `PrismaClient` sin alternativa. En un
 * proyecto de ZenStack v3 ese paquete puede no existir, asi que el seeder
 * generado no compilaria.
 */
describe('tipado del cliente en la plantilla TypeScript', () => {
  it('con clientType propio emite ese import y ese tipo', () => {
    const code = renderTemplate('ts', {
      name: 'User',
      clientType: { import: "import type { db } from '../../src/db'", type: 'typeof db' },
    });

    expect(code).toContain("import type { db } from '../../src/db';");
    expect(code).toContain('SeedContext<typeof db>');
    expect(code).not.toContain('@prisma/client');
  });

  /**
   * Sin saber cual es el cliente, la plantilla no puede importar `PrismaClient`
   * — pero tampoco debe rellenar con `any` ni generar un archivo que no compila.
   * Declara una interfaz local minima y deja escrita la linea que hay que
   * cambiar para tipar de verdad.
   */
  it('con clientType null declara una interfaz local en vez de usar any', () => {
    const code = renderTemplate('ts', { name: 'UserProfile', clientType: null });

    expect(code).not.toContain('@prisma/client');
    expect(code).not.toMatch(/\bany\b/);
    expect(code).toContain('interface AppClient {');
    expect(code).toContain('userProfile: {');
    expect(code).toContain('type Ctx = SeedContext<AppClient>;');
    expect(code).toContain('type AppClient = typeof db;');
    expect(code).toContain('ZenStack');
  });

  it('el cuerpo del seeder es identico se tipe como se tipe', () => {
    const conPrisma = renderTemplate('ts', { name: 'User' });
    const sinTipo = renderTemplate('ts', { name: 'User', clientType: null });

    for (const code of [conPrisma, sinTipo]) {
      expect(code).toContain('export async function main({ prisma, logger }: Ctx)');
      expect(code).toContain('prisma.user.upsert');
      expect(code).not.toContain('new PrismaClient()');
    }
  });
});
