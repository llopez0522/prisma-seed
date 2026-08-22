import pkg from '../package.json' with { type: 'json' };

/**
 * Version del paquete.
 *
 * Se importa el package.json en vez de inyectar una global en compilacion: el
 * `define` de Vite no se aplica en la transformacion SSR que usa Vitest, asi que
 * un `__VERSION__` inyectado solo existiria en el bundle y romperia en los tests.
 * Con un import normal, tsup lo resuelve al compilar y Vitest al ejecutar.
 */
export const VERSION: string = pkg.version;
