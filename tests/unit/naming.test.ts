import { describe, expect, it } from 'vitest';

import {
  buildSeedFileName,
  formatTimestamp,
  toModelAccessor,
  toModelName,
} from '../../src/core/naming.js';

describe('toModelName', () => {
  it('capitaliza la primera letra', () => {
    expect(toModelName('user')).toBe('User');
    expect(toModelName('post')).toBe('Post');
  });

  it('conserva un PascalCase que ya venia bien', () => {
    expect(toModelName('UserProfile')).toBe('UserProfile');
  });

  it('convierte snake_case y kebab-case a PascalCase', () => {
    expect(toModelName('user_profile')).toBe('UserProfile');
    expect(toModelName('user-profile')).toBe('UserProfile');
    expect(toModelName('order_line_item')).toBe('OrderLineItem');
  });

  it('tolera vacios y espacios', () => {
    expect(toModelName('')).toBe('');
    expect(toModelName('  user  ')).toBe('User');
  });
});

/**
 * B9: la v0.2.4 generaba el accesor con `toLowerCase()`, produciendo
 * `prisma.userprofile`, que no existe. Prisma solo pone en minuscula la primera
 * letra. Verificado contra Prisma real en la fase 0.
 */
describe('toModelAccessor (B9)', () => {
  it('pone en minuscula SOLO la primera letra', () => {
    expect(toModelAccessor('UserProfile')).toBe('userProfile');
    expect(toModelAccessor('OrderLineItem')).toBe('orderLineItem');
  });

  it('no es lo mismo que toLowerCase, que era el bug', () => {
    const modelo = 'UserProfile';

    expect(toModelAccessor(modelo)).toBe('userProfile');
    expect(toModelAccessor(modelo)).not.toBe(modelo.toLowerCase());
  });

  it('funciona con modelos de una sola palabra', () => {
    expect(toModelAccessor('User')).toBe('user');
    expect(toModelAccessor('user')).toBe('user');
  });

  it('normaliza antes de convertir', () => {
    expect(toModelAccessor('user_profile')).toBe('userProfile');
  });
});

describe('formatTimestamp', () => {
  it('produce 14 digitos en formato YYYYMMDDHHmmss', () => {
    const ts = formatTimestamp(new Date(2024, 0, 5, 9, 8, 7));

    expect(ts).toBe('20240105090807');
    expect(ts).toHaveLength(14);
  });

  it('rellena con ceros a la izquierda', () => {
    expect(formatTimestamp(new Date(2024, 8, 1, 0, 0, 0))).toBe('20240901000000');
  });

  // El orden de ejecucion depende de la comparacion lexicografica del prefijo.
  it('el orden lexicografico coincide con el cronologico', () => {
    const antes = formatTimestamp(new Date(2024, 0, 1, 0, 0, 0));
    const despues = formatTimestamp(new Date(2024, 11, 31, 23, 59, 59));

    expect(antes < despues).toBe(true);
  });
});

describe('buildSeedFileName', () => {
  it('combina timestamp, modelo y extension', () => {
    const nombre = buildSeedFileName('user', '.js', new Date(2024, 0, 5, 9, 8, 7));

    expect(nombre).toBe('20240105090807_User.js');
  });

  it('respeta la extension de TypeScript', () => {
    const nombre = buildSeedFileName('user', '.ts', new Date(2024, 0, 5, 9, 8, 7));

    expect(nombre).toBe('20240105090807_User.ts');
  });
});
