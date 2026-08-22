import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectFlavor, generateCommand, resolveClientType } from '../../src/commands/generate.js';
import { CliError, UsageError } from '../../src/core/errors.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function pkg(contents: object): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(contents));
}

function seedersDir(): string {
  return path.join(cwd, 'prisma', 'seeders');
}

function listSeeders(): string[] {
  return fs.existsSync(seedersDir()) ? fs.readdirSync(seedersDir()) : [];
}

describe('detectFlavor', () => {
  function seeder(nombre: string): void {
    const dir = path.join(cwd, 'prisma', 'seeders');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), '');
  }

  const dirDeSeeders = (): string => path.join(cwd, 'prisma', 'seeders');

  it('devuelve esm si el package.json declara type module', () => {
    pkg({ type: 'module' });
    expect(detectFlavor(cwd, undefined).flavor).toBe('esm');
  });

  it('devuelve cjs por defecto', () => {
    pkg({});
    expect(detectFlavor(cwd, undefined).flavor).toBe('cjs');
  });

  it('devuelve cjs si no hay package.json', () => {
    expect(detectFlavor(cwd, undefined).flavor).toBe('cjs');
  });

  it('--ts gana sobre la deteccion', () => {
    pkg({ type: 'module' });
    expect(detectFlavor(cwd, true).flavor).toBe('ts');
  });

  it('un package.json corrupto no impide generar', () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{ roto');
    expect(detectFlavor(cwd, undefined).flavor).toBe('cjs');
  });

  /**
   * El motivo de la escalera: pedir `--ts` en cada invocacion era incoherente.
   * Si el proyecto es TypeScript, el seeder sale en TypeScript.
   */
  it('un proyecto con tsconfig.json genera TypeScript sin pedirlo', () => {
    pkg({});
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');

    const decision = detectFlavor(cwd, undefined);
    expect(decision.flavor).toBe('ts');
    expect(decision.reason).toContain('tsconfig.json');
  });

  // La senal mas fiable: escribir el siguiente igual que el ultimo.
  it('imita a los seeders que ya existen antes que mirar el tsconfig', () => {
    pkg({ type: 'module' });
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
    seeder('20240101000001_User.mjs');

    const decision = detectFlavor(cwd, undefined, { seedersDir: dirDeSeeders() });
    expect(decision.flavor).toBe('esm');
    expect(decision.reason).toContain('ya hay');
  });

  it('un .ts existente manda aunque no haya tsconfig', () => {
    pkg({});
    seeder('20240101000001_User.ts');

    expect(detectFlavor(cwd, undefined, { seedersDir: dirDeSeeders() }).flavor).toBe('ts');
  });

  // `.js` es ambiguo: no dice si el proyecto es ESM o CommonJS.
  it('un .js existente no decide por si solo, cae a package.json', () => {
    pkg({ type: 'module' });
    seeder('20240101000001_User.js');

    expect(detectFlavor(cwd, undefined, { seedersDir: dirDeSeeders() }).flavor).toBe('esm');
  });

  it('seederLanguage gana a los seeders existentes y al tsconfig', () => {
    pkg({});
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
    seeder('20240101000001_User.ts');

    const decision = detectFlavor(cwd, undefined, {
      configured: 'cjs',
      seedersDir: dirDeSeeders(),
    });
    expect(decision.flavor).toBe('cjs');
    expect(decision.reason).toContain('seederLanguage');
  });

  it('--js escapa de un proyecto TypeScript', () => {
    pkg({ type: 'module' });
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');

    const decision = detectFlavor(cwd, undefined, { forceJs: true });
    expect(decision.flavor).toBe('esm');
    expect(decision.reason).toBe('--js');
  });

  it('--ts gana incluso a --js', () => {
    expect(detectFlavor(cwd, true, { forceJs: true }).flavor).toBe('ts');
  });
});

describe('generateCommand', () => {
  it('crea el directorio de seeders y el archivo', async () => {
    await generateCommand('user', { cwd, quiet: true });

    const archivos = listSeeders();
    expect(archivos).toHaveLength(1);
    expect(archivos[0]).toMatch(/^\d{14}_User\.js$/);
  });

  it('genera .ts con --ts', async () => {
    await generateCommand('user', { cwd, quiet: true, ts: true });

    expect(listSeeders()[0]).toMatch(/^\d{14}_User\.ts$/);
  });

  /**
   * B10: `generate ../../../../tmp/pwned` en la v0.2.4 resolvia a una ruta fuera
   * del directorio de seeders. Verificado en la fase 0.
   */
  it.each(['../../../../tmp/pwned', '../evil', 'a/b', 'a\\b', '.hidden', ''])(
    'rechaza el nombre peligroso "%s"',
    async (nombre) => {
      await expect(generateCommand(nombre, { cwd, quiet: true })).rejects.toThrow(UsageError);
      expect(listSeeders()).toHaveLength(0);
    }
  );

  it('rechaza tambien un --model peligroso', async () => {
    await expect(generateCommand('user', { cwd, quiet: true, model: '../../x' })).rejects.toThrow(
      UsageError
    );
  });

  /**
   * B11: la v0.2.4 capturaba el error y solo lo logueaba, asi que el proceso
   * salia con codigo 0 aunque no hubiera generado nada. Aqui debe propagarse.
   */
  it('lanza si el seeder ya existe, en vez de fallar en silencio', async () => {
    fs.mkdirSync(seedersDir(), { recursive: true });
    await generateCommand('user', { cwd, quiet: true });
    const existente = listSeeders()[0]!;

    // Se recrea el mismo nombre forzando el mismo timestamp.
    fs.writeFileSync(path.join(seedersDir(), existente), 'ya estaba');

    await expect(generateCommand('user', { cwd, quiet: true })).rejects.toThrow(CliError);
  });

  it('respeta seedersDir de la configuracion', async () => {
    pkg({ prismaSeeder: { seedersDir: 'db/semillas' } });

    await generateCommand('user', { cwd, quiet: true });

    expect(fs.readdirSync(path.join(cwd, 'db', 'semillas'))).toHaveLength(1);
  });

  // B4: generar un archivo no necesita base de datos ni @prisma/client.
  it('funciona sin @prisma/client instalado', async () => {
    pkg({ name: 'proyecto-sin-prisma' });

    await expect(generateCommand('user', { cwd, quiet: true })).resolves.toBeUndefined();
    expect(listSeeders()).toHaveLength(1);
  });

  it('el contenido generado apunta al accesor correcto', async () => {
    await generateCommand('UserProfile', { cwd, quiet: true });

    const contenido = fs.readFileSync(path.join(seedersDir(), listSeeders()[0]!), 'utf8');
    expect(contenido).toContain('prisma.userProfile');
  });
});

describe('resolveClientType', () => {
  it('lo configurado manda', () => {
    const spec = { import: "import type { db } from '../db'", type: 'typeof db' };
    expect(resolveClientType(spec, true)).toBe(spec);
    expect(resolveClientType(spec, false)).toBe(spec);
  });

  // La pregunta no es que ORM usa el proyecto, sino algo comprobable.
  it('sin @prisma/client resoluble, no se importa @prisma/client', () => {
    expect(resolveClientType(undefined, false)).toBeNull();
  });

  it('con @prisma/client resoluble, se mantiene el tipado de siempre', () => {
    expect(resolveClientType(undefined, true)).toBeUndefined();
  });
});

describe('generate en un proyecto sin @prisma/client', () => {
  function zenstackProject(): void {
    fs.mkdirSync(path.join(cwd, 'zenstack'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'zenstack', 'schema.zmodel'),
      "datasource db {\n  provider = 'postgresql'\n}\n"
    );
    pkg({ type: 'module' });
  }

  it('el seeder .ts generado no importa @prisma/client', async () => {
    zenstackProject();

    await generateCommand('user', { cwd, quiet: true, ts: true });

    const file = path.join(seedersDir(), listSeeders()[0]!);
    const code = fs.readFileSync(file, 'utf8');

    expect(code).not.toContain('@prisma/client');
    expect(code).toContain("import type { SeedContext } from 'prisma-seed'");
  });

  it('respeta clientType de la configuracion', async () => {
    zenstackProject();
    fs.writeFileSync(
      path.join(cwd, 'seeder.config.mjs'),
      `export default { clientType: { import: "import type { db } from '../../src/db'", type: 'typeof db' } };`
    );

    await generateCommand('user', { cwd, quiet: true, ts: true });

    const code = fs.readFileSync(path.join(seedersDir(), listSeeders()[0]!), 'utf8');
    expect(code).toContain('SeedContext<typeof db>');
  });

  it('sigue generando en prisma/seeders sea cual sea el schema', async () => {
    zenstackProject();

    await generateCommand('user', { cwd, quiet: true });

    expect(listSeeders()[0]).toMatch(/^\d{14}_User\.js$/);
  });

  // El caso que motivo la escalera: un proyecto TypeScript no deberia tener que
  // acordarse de `--ts` en cada invocacion.
  it('con tsconfig.json genera .ts sin pasar --ts', async () => {
    zenstackProject();
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');

    await generateCommand('user', { cwd, quiet: true });

    expect(listSeeders()[0]).toMatch(/^\d{14}_User\.ts$/);
  });
});
