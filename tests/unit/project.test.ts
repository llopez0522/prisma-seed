import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverSchemaPath,
  findProjectRoot,
  schemaPathFromPackageJson,
} from '../../src/core/project.js';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents = ''): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

describe('findProjectRoot', () => {
  it('sube hasta el package.json mas cercano', () => {
    write('package.json', '{}');
    const hondo = path.join(root, 'apps', 'api', 'src');
    fs.mkdirSync(hondo, { recursive: true });

    expect(findProjectRoot(hondo)).toBe(root);
  });

  it('en un monorepo se queda en el paquete, no en la raiz', () => {
    write('package.json', '{}');
    write('apps/api/package.json', '{}');
    const hondo = path.join(root, 'apps', 'api', 'src', 'modules');
    fs.mkdirSync(hondo, { recursive: true });

    expect(findProjectRoot(hondo)).toBe(path.join(root, 'apps', 'api'));
  });

  it('reconoce tambien una carpeta prisma/ o zenstack/ como raiz', () => {
    fs.mkdirSync(path.join(root, 'zenstack'), { recursive: true });
    const hondo = path.join(root, 'src', 'db');
    fs.mkdirSync(hondo, { recursive: true });

    expect(findProjectRoot(hondo)).toBe(root);
  });

  /**
   * La red de seguridad: sin ninguna marca, se devuelve el directorio de
   * partida. Si se escapara hacia arriba, `generate` podria escribir en un
   * proyecto ajeno.
   */
  it('devuelve el directorio de partida si no hay ninguna marca', () => {
    const hondo = path.join(root, 'a', 'b');
    fs.mkdirSync(hondo, { recursive: true });

    expect(findProjectRoot(hondo)).toBe(hondo);
  });

  it('el propio directorio cuenta como raiz si tiene la marca', () => {
    write('package.json', '{}');
    expect(findProjectRoot(root)).toBe(root);
  });
});

describe('schemaPathFromPackageJson', () => {
  it('lee la clave zenstack.schema', () => {
    write('package.json', JSON.stringify({ zenstack: { schema: 'db/schema.zmodel' } }));
    expect(schemaPathFromPackageJson(root)).toBe('db/schema.zmodel');
  });

  it('lee la clave prisma.schema', () => {
    write('package.json', JSON.stringify({ prisma: { schema: 'db/schema.prisma' } }));
    expect(schemaPathFromPackageJson(root)).toBe('db/schema.prisma');
  });

  it('zenstack gana si estan las dos', () => {
    write(
      'package.json',
      JSON.stringify({ zenstack: { schema: 'a.zmodel' }, prisma: { schema: 'b.prisma' } })
    );
    expect(schemaPathFromPackageJson(root)).toBe('a.zmodel');
  });

  it('devuelve null sin package.json, sin la clave o con json corrupto', () => {
    expect(schemaPathFromPackageJson(root)).toBeNull();

    write('package.json', JSON.stringify({ name: 'x' }));
    expect(schemaPathFromPackageJson(root)).toBeNull();

    write('package.json', '{ roto');
    expect(schemaPathFromPackageJson(root)).toBeNull();
  });
});

describe('discoverSchemaPath', () => {
  it('devuelve null si el proyecto no tiene schema', () => {
    expect(discoverSchemaPath(root)).toBeNull();
  });

  it('encuentra prisma/schema.prisma', () => {
    write('prisma/schema.prisma');
    expect(discoverSchemaPath(root)).toBe('prisma/schema.prisma');
  });

  // El valor por defecto del CLI de ZenStack v3.
  it('encuentra zenstack/schema.zmodel', () => {
    write('zenstack/schema.zmodel');
    expect(discoverSchemaPath(root)).toBe('zenstack/schema.zmodel');
  });

  it('encuentra schema.zmodel en la raiz', () => {
    write('schema.zmodel');
    expect(discoverSchemaPath(root)).toBe('schema.zmodel');
  });

  it('prefiere Prisma cuando conviven los dos, para no cambiar proyectos existentes', () => {
    write('prisma/schema.prisma');
    write('zenstack/schema.zmodel');
    expect(discoverSchemaPath(root)).toBe('prisma/schema.prisma');
  });

  it('lo declarado en package.json gana sobre los candidatos', () => {
    write('prisma/schema.prisma');
    write('db/mi.zmodel');
    write('package.json', JSON.stringify({ zenstack: { schema: 'db/mi.zmodel' } }));

    expect(discoverSchemaPath(root)).toBe('db/mi.zmodel');
  });

  // Que el error apunte a la ruta que puso el usuario, no a una generica.
  it('devuelve la ruta declarada aunque no exista', () => {
    write('package.json', JSON.stringify({ zenstack: { schema: 'no/existe.zmodel' } }));
    expect(discoverSchemaPath(root)).toBe('no/existe.zmodel');
  });
});
