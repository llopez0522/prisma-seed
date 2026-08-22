import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../../src/core/errors.js';
import { isSupportedExtension, loadSeederModule } from '../../src/core/loader.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('isSupportedExtension', () => {
  it('acepta las extensiones ejecutables por Node y TypeScript', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']) {
      expect(isSupportedExtension(ext)).toBe(true);
    }
  });

  it('rechaza el resto', () => {
    for (const ext of ['.json', '.md', '.txt', '']) {
      expect(isSupportedExtension(ext)).toBe(false);
    }
  });
});

describe('loadSeederModule', () => {
  it('carga un seeder ESM con main y down', async () => {
    const file = write(
      'esm.mjs',
      `export async function main() { return 'main'; }
       export async function down() { return 'down'; }`
    );

    const mod = await loadSeederModule(file);
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.down).toBe('function');
  });

  // Es la forma exacta que generaba la plantilla CommonJS de la v0.2.4.
  it('carga un seeder CommonJS con module.exports', async () => {
    const file = write(
      'cjs.cjs',
      `async function main() { return 'main'; }
       async function down() { return 'down'; }
       module.exports = { main, down };`
    );

    const mod = await loadSeederModule(file);
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.down).toBe('function');
  });

  // El mismo patron de interop que rompia inquirer (B13): todo bajo .default.
  it('aplana los exports que quedan bajo .default', async () => {
    const file = write(
      'default-only.mjs',
      `export default { main: async () => 'main', down: async () => 'down' };`
    );

    const mod = await loadSeederModule(file);
    expect(typeof mod.main).toBe('function');
    expect(await mod.main?.({} as never)).toBe('main');
  });

  it('prefiere los exports de la raiz frente a los de .default', async () => {
    const file = write(
      'ambos.mjs',
      `export const main = async () => 'raiz';
       export default { main: async () => 'default' };`
    );

    const mod = await loadSeederModule(file);
    expect(await mod.main?.({} as never)).toBe('raiz');
  });

  it('no inventa funciones cuando el modulo no las tiene', async () => {
    const file = write('vacio.mjs', `export const algo = 1;`);

    const mod = await loadSeederModule(file);
    expect(mod.main).toBeUndefined();
    expect(mod.down).toBeUndefined();
  });

  it('recoge order y dependencies cuando estan declarados', async () => {
    const file = write(
      'meta.mjs',
      `export const order = 5;
       export const dependencies = ['User', 'Post', 42];
       export async function main() {}`
    );

    const mod = await loadSeederModule(file);
    expect(mod.order).toBe(5);
    // El 42 se descarta: dependencies son nombres, no numeros.
    expect(mod.dependencies).toEqual(['User', 'Post']);
  });

  it('lanza CliError con contexto si el archivo no existe', async () => {
    await expect(loadSeederModule(path.join(dir, 'fantasma.mjs'))).rejects.toBeInstanceOf(CliError);
  });

  it('propaga los errores de sintaxis del seeder', async () => {
    const file = write('roto.mjs', `export async function main( {{{`);

    await expect(loadSeederModule(file)).rejects.toThrow(CliError);
  });
});

/**
 * B8: la v0.2.4 construia la URL como `new URL('file://' + rutaAbsoluta)`.
 *
 * La carga end-to-end de una ruta con caracteres especiales NO se puede verificar
 * aqui: Vitest enruta todo `import()` dinamico por su propio module runner, que no
 * resuelve URLs file:// porcentaje-codificadas. Se comprobo a mano contra Node real
 * (v20.20.2) que `loadSeederModule` si carga
 * `/tmp/probe/con espacios y #almohadilla/seed.mjs`, y que el metodo de la v0.2.4
 * falla con ERR_MODULE_NOT_FOUND sobre esa misma ruta.
 *
 * Lo que si se puede fijar aqui de forma determinista es la causa raiz: la
 * diferencia entre ambas formas de construir la URL. La cobertura end-to-end llega
 * con la suite de integracion (fase 7), que ejecuta el CLI como proceso real.
 */
describe('construccion de la URL de modulo (B8)', () => {
  const rompenLaConcatenacion = [
    // La # inicia un fragmento: la ruta queda truncada.
    ['almohadilla', '/tmp/con#almohadilla/seed.mjs'],
    // La ? inicia un query string: idem.
    ['interrogante', '/tmp/con?interrogante/seed.mjs'],
    // El % se interpreta como escape ya existente y se decodifica de mas.
    ['porcentaje', '/tmp/con%20literal/seed.mjs'],
  ] as const;

  it.each(rompenLaConcatenacion)(
    'pathToFileURL preserva la ruta con %s y la concatenacion la corrompe',
    (_etiqueta, ruta) => {
      expect(fileURLToPath(pathToFileURL(ruta))).toBe(ruta);
      expect(fileURLToPath(new URL(`file://${ruta}`))).not.toBe(ruta);
    }
  );

  // Correccion a mi propio diagnostico inicial: yo habia afirmado que la
  // concatenacion fallaba con espacios. No es cierto. `new URL` los normaliza a
  // %20 igual que pathToFileURL, y la ruta sobrevive intacta. El fallo con
  // espacios que observe al principio venia de la # que habia en la misma ruta.
  it('los espacios funcionan con ambos metodos: no eran el problema', () => {
    const ruta = '/tmp/con espacios/seed.mjs';

    expect(fileURLToPath(pathToFileURL(ruta))).toBe(ruta);
    expect(fileURLToPath(new URL(`file://${ruta}`))).toBe(ruta);
  });

  it('detalla como se pierde la ruta tras la almohadilla', () => {
    const comoV024 = new URL('file:///tmp/con#almohadilla/seed.mjs');

    expect(comoV024.pathname).toBe('/tmp/con');
    expect(comoV024.hash).toBe('#almohadilla/seed.mjs');
  });
});
