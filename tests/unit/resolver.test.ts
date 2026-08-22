import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UsageError } from '../../src/core/errors.js';
import {
  assertValidSeedName,
  discoverSeeders,
  findSeederByName,
  isValidSeedName,
  sortSeeders,
  stripTimestamp,
} from '../../src/core/resolver.js';
import type { DiscoveredSeeder } from '../../src/types.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeders-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function touch(name: string): void {
  fs.writeFileSync(path.join(dir, name), '');
}

function seeder(name: string, timestamp: string | null = null): DiscoveredSeeder {
  return { name, absolutePath: `/tmp/${name}`, timestamp };
}

describe('discoverSeeders', () => {
  it('devuelve lista vacia si el directorio no existe', () => {
    expect(discoverSeeders(path.join(dir, 'no-existe'))).toEqual([]);
  });

  it('reconoce .js, .mjs, .cjs y .ts, e ignora el resto', () => {
    touch('20240101000001_A.js');
    touch('20240101000002_B.mjs');
    touch('20240101000003_C.cjs');
    touch('20240101000004_D.ts');
    touch('notas.md');
    touch('datos.json');

    expect(discoverSeeders(dir).map((s) => s.name)).toEqual([
      '20240101000001_A',
      '20240101000002_B',
      '20240101000003_C',
      '20240101000004_D',
    ]);
  });

  it('ignora los .d.ts, que son declaraciones y no seeders', () => {
    touch('20240101000001_A.ts');
    touch('tipos.d.ts');

    expect(discoverSeeders(dir).map((s) => s.name)).toEqual(['20240101000001_A']);
  });

  // La v0.2.4 hacia file.replace('.js', ''), que sustituye la PRIMERA aparicion
  // de la subcadena en cualquier posicion, no la extension.
  it('deriva el nombre de la extension real, no con replace de subcadena', () => {
    touch('Archive.js.js');

    const [found] = discoverSeeders(dir);
    expect(found?.name).toBe('Archive.js');
  });

  it('extrae el prefijo de timestamp cuando existe', () => {
    touch('20240101120000_User.js');
    touch('SinPrefijo.js');

    const byName = Object.fromEntries(discoverSeeders(dir).map((s) => [s.name, s.timestamp]));
    expect(byName['20240101120000_User']).toBe('20240101120000');
    expect(byName['SinPrefijo']).toBeNull();
  });

  it('ignora los subdirectorios', () => {
    fs.mkdirSync(path.join(dir, 'sub.js'));
    touch('20240101000001_A.js');

    expect(discoverSeeders(dir).map((s) => s.name)).toEqual(['20240101000001_A']);
  });
});

describe('sortSeeders', () => {
  it('ordena cronologicamente los que tienen timestamp', () => {
    const sorted = sortSeeders([
      seeder('20240301000000_C', '20240301000000'),
      seeder('20240101000000_A', '20240101000000'),
      seeder('20240201000000_B', '20240201000000'),
    ]);

    expect(sorted.map((s) => s.name)).toEqual([
      '20240101000000_A',
      '20240201000000_B',
      '20240301000000_C',
    ]);
  });

  it('coloca los seeders sin timestamp al final, alfabeticamente', () => {
    const sorted = sortSeeders([
      seeder('Zeta'),
      seeder('20240101000000_A', '20240101000000'),
      seeder('Alfa'),
    ]);

    expect(sorted.map((s) => s.name)).toEqual(['20240101000000_A', 'Alfa', 'Zeta']);
  });

  it('no muta el array recibido', () => {
    const input = [seeder('B'), seeder('A')];
    sortSeeders(input);
    expect(input.map((s) => s.name)).toEqual(['B', 'A']);
  });
});

describe('findSeederByName', () => {
  const seeders = [
    seeder('20240101000000_User', '20240101000000'),
    seeder('20240102000000_Post', '20240102000000'),
    seeder('20240103000000_UserProfile', '20240103000000'),
  ];

  it('encuentra por nombre completo exacto', () => {
    expect(findSeederByName(seeders, '20240101000000_User').name).toBe('20240101000000_User');
  });

  it('encuentra ignorando el prefijo de timestamp', () => {
    expect(findSeederByName(seeders, 'Post').name).toBe('20240102000000_Post');
  });

  it('encuentra sin distinguir mayusculas', () => {
    expect(findSeederByName(seeders, 'userprofile').name).toBe('20240103000000_UserProfile');
  });

  // "User" coincide parcialmente con User y UserProfile: hay que fallar, no elegir.
  it('falla de forma explicita cuando la busqueda es ambigua', () => {
    expect(() => findSeederByName(seeders, 'User')).not.toThrow();

    const ambiguos = [seeder('AlfaUno'), seeder('AlfaDos')];
    try {
      findSeederByName(ambiguos, 'Alfa');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('ambiguo');
      expect((error as UsageError).hint).toContain('AlfaUno');
      expect((error as UsageError).hint).toContain('AlfaDos');
    }
  });

  it('prefiere la coincidencia exacta sobre la parcial', () => {
    const conAmbas = [seeder('User'), seeder('UserProfile')];
    expect(findSeederByName(conAmbas, 'User').name).toBe('User');
  });

  it('lista los disponibles cuando no hay coincidencia', () => {
    try {
      findSeederByName(seeders, 'NoExiste');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect((error as UsageError).hint).toContain('20240101000000_User');
    }
  });

  it('da una pista distinta cuando no hay ningun seeder', () => {
    try {
      findSeederByName([], 'Loquesea');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect((error as UsageError).hint).toContain('generate');
    }
  });
});

describe('validacion de nombres (B10)', () => {
  it('acepta nombres razonables', () => {
    for (const name of ['User', 'user_profile', 'Post-2', 'A1']) {
      expect(isValidSeedName(name)).toBe(true);
    }
  });

  it('rechaza los intentos de escape de directorio', () => {
    for (const name of ['../../etc/passwd', '../../../../tmp/pwned', 'a/b', 'a\\b', '.hidden']) {
      expect(isValidSeedName(name)).toBe(false);
    }
  });

  it('rechaza vacios y nombres que no empiezan por letra', () => {
    for (const name of ['', ' ', '1User', '_priv', '-x']) {
      expect(isValidSeedName(name)).toBe(false);
    }
  });

  it('assertValidSeedName lanza UsageError', () => {
    expect(() => assertValidSeedName('../x')).toThrow(UsageError);
    expect(() => assertValidSeedName('User')).not.toThrow();
  });
});

describe('stripTimestamp', () => {
  it('quita el prefijo solo cuando tiene el formato exacto', () => {
    expect(stripTimestamp('20240101120000_User')).toBe('User');
    expect(stripTimestamp('User')).toBe('User');
    expect(stripTimestamp('2024_User')).toBe('2024_User');
  });
});
