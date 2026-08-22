import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, findConfigFile, loadConfig } from '../../src/core/config.js';
import { CliError } from '../../src/core/errors.js';
import type { SeedClient } from '../../src/types.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writePackageJson(contents: object): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(contents));
}

describe('loadConfig', () => {
  it('usa los valores por defecto de la v0.2.4 cuando no hay configuracion', async () => {
    const config = await loadConfig(cwd);

    expect(config.seedersDir).toBe(DEFAULT_CONFIG.seedersDir);
    expect(config.seedersDir).toBe('prisma/seeders');
    expect(config.ledgerTable).toBe('SeedExecution');
    expect(config.transactional).toBe(true);
    expect(config.sourceFile).toBeNull();
  });

  it('resuelve las rutas a absolutas contra el cwd', async () => {
    const config = await loadConfig(cwd);

    expect(config.seedersDirAbsolute).toBe(path.join(cwd, 'prisma', 'seeders'));
    expect(config.schemaPathAbsolute).toBe(path.join(cwd, 'prisma', 'schema.prisma'));
    expect(path.isAbsolute(config.seedersDirAbsolute)).toBe(true);
  });

  it('lee la clave prismaSeeder de package.json', async () => {
    writePackageJson({ name: 'x', prismaSeeder: { seedersDir: 'db/seeds' } });

    const config = await loadConfig(cwd);
    expect(config.seedersDir).toBe('db/seeds');
    expect(config.seedersDirAbsolute).toBe(path.join(cwd, 'db', 'seeds'));
  });

  it('carga seeder.config.mjs y le da prioridad sobre package.json', async () => {
    writePackageJson({ name: 'x', prismaSeeder: { seedersDir: 'de-package-json' } });
    fs.writeFileSync(
      path.join(cwd, 'seeder.config.mjs'),
      `export default { seedersDir: 'de-config-file' };`
    );

    const config = await loadConfig(cwd);
    expect(config.seedersDir).toBe('de-config-file');
    expect(config.sourceFile).toContain('seeder.config.mjs');
  });

  it('los overrides de linea de comandos ganan a todo lo demas', async () => {
    writePackageJson({ name: 'x', prismaSeeder: { seedersDir: 'de-package-json' } });
    fs.writeFileSync(
      path.join(cwd, 'seeder.config.mjs'),
      `export default { seedersDir: 'de-config-file' };`
    );

    const config = await loadConfig(cwd, { seedersDir: 'de-cli' });
    expect(config.seedersDir).toBe('de-cli');
  });

  // Sin stripUndefined, un undefined explicito pisaria la capa inferior.
  it('un undefined explicito no pisa el valor de la capa inferior', async () => {
    writePackageJson({ name: 'x', prismaSeeder: { seedersDir: 'db/seeds' } });

    const config = await loadConfig(cwd, { seedersDir: undefined });
    expect(config.seedersDir).toBe('db/seeds');
  });

  it('rechaza un ledgerTable que no sea identificador SQL valido', async () => {
    await expect(loadConfig(cwd, { ledgerTable: 'tabla; DROP TABLE users' })).rejects.toThrow(
      CliError
    );
    await expect(loadConfig(cwd, { ledgerTable: '' })).rejects.toThrow(CliError);
    await expect(loadConfig(cwd, { ledgerTable: '1tabla' })).rejects.toThrow(CliError);
  });

  it('acepta un ledgerTable personalizado valido', async () => {
    const config = await loadConfig(cwd, { ledgerTable: 'mis_seeds' });
    expect(config.ledgerTable).toBe('mis_seeds');
  });

  it('informa con claridad si el archivo de configuracion no exporta un objeto', async () => {
    fs.writeFileSync(path.join(cwd, 'seeder.config.mjs'), `export default 42;`);

    await expect(loadConfig(cwd)).rejects.toThrow(/configuracion/i);
  });

  it('tolera un package.json sin la clave prismaSeeder', async () => {
    writePackageJson({ name: 'x' });
    await expect(loadConfig(cwd)).resolves.toBeDefined();
  });

  it('falla con mensaje util si el package.json esta corrupto', async () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{ esto no es json');
    await expect(loadConfig(cwd)).rejects.toThrow(/package\.json/);
  });
});

describe('findConfigFile', () => {
  it('devuelve null si no hay ninguno', () => {
    expect(findConfigFile(cwd)).toBeNull();
  });

  it('prefiere seeder.config.ts sobre las variantes en JavaScript', () => {
    fs.writeFileSync(path.join(cwd, 'seeder.config.js'), '');
    fs.writeFileSync(path.join(cwd, 'seeder.config.ts'), '');

    expect(findConfigFile(cwd)).toContain('seeder.config.ts');
  });
});

describe('autodeteccion de schemaPath', () => {
  it('sin nada declarado, cae al valor por defecto de Prisma', async () => {
    const config = await loadConfig(cwd);

    expect(config.schemaPath).toBe('prisma/schema.prisma');
    expect(config.schemaPathDetected).toBe(true);
  });

  it('encuentra zenstack/schema.zmodel sin configurar nada', async () => {
    fs.mkdirSync(path.join(cwd, 'zenstack'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'zenstack', 'schema.zmodel'), '');

    const config = await loadConfig(cwd);

    expect(config.schemaPath).toBe('zenstack/schema.zmodel');
    expect(config.schemaPathAbsolute).toBe(path.join(cwd, 'zenstack', 'schema.zmodel'));
  });

  it('respeta zenstack.schema de package.json', async () => {
    fs.mkdirSync(path.join(cwd, 'db'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'db', 'mi.zmodel'), '');
    writePackageJson({ name: 'x', zenstack: { schema: 'db/mi.zmodel' } });

    const config = await loadConfig(cwd);
    expect(config.schemaPath).toBe('db/mi.zmodel');
  });

  it('un schemaPath explicito desactiva la deteccion', async () => {
    fs.mkdirSync(path.join(cwd, 'zenstack'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'zenstack', 'schema.zmodel'), '');

    const config = await loadConfig(cwd, { schemaPath: 'otro/sitio.prisma' });

    expect(config.schemaPath).toBe('otro/sitio.prisma');
    expect(config.schemaPathDetected).toBe(false);
  });
});

describe('inyeccion del cliente por configuracion', () => {
  it('acepta un cliente literal', async () => {
    const client: SeedClient = {
      $queryRawUnsafe: <T>(): Promise<T> => Promise.resolve([] as unknown as T),
      $executeRawUnsafe: (): Promise<number> => Promise.resolve(0),
    };

    const config = await loadConfig(cwd, { client });
    expect(config.client).toBe(client);
  });

  it('acepta una fabrica y no la invoca al cargar la configuracion', async () => {
    let invocada = false;
    const factory = (): never => {
      invocada = true;
      throw new Error('no deberia llamarse aqui');
    };

    const config = await loadConfig(cwd, { client: factory });

    expect(config.client).toBe(factory);
    expect(invocada).toBe(false);
  });

  it('rechaza un client que no es ni objeto ni funcion', async () => {
    await expect(loadConfig(cwd, { client: 'db' as never })).rejects.toThrow(CliError);
  });

  it('valida la forma de clientType', async () => {
    await expect(loadConfig(cwd, { clientType: { import: 'x' } as never })).rejects.toThrow(
      /clientType/
    );

    const ok = await loadConfig(cwd, {
      clientType: { import: "import type { db } from '../../src/db'", type: 'typeof db' },
    });
    expect(ok.clientType?.type).toBe('typeof db');
  });
});
