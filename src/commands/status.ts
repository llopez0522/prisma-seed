import pc from 'picocolors';

import { closeContext, createContext, type GlobalFlags } from './context.js';
import { discoverSeeders } from '../core/resolver.js';
import { buildStatus, type SeederStatus, type StatusSummary } from '../core/status.js';

/**
 * `status` — equivalente a `migrate:status` de Laravel.
 *
 * Es el unico comando que **no escribe nada**: ni siquiera crea la tabla del
 * ledger. Si no existe, sencillamente no hay nada ejecutado y todo sale como
 * pendiente. Un comando de consulta que modifica la base es una trampa.
 */

const ETIQUETA: Record<SeederStatus['state'], string> = {
  applied: 'ejecutado',
  pending: 'pendiente',
  'missing-file': 'sin archivo',
};

export async function statusCommand(options: GlobalFlags): Promise<void> {
  const ctx = await createContext(options);

  try {
    const enDisco = discoverSeeders(ctx.config.seedersDirAbsolute);
    const registros = (await ctx.ledger.tableExists()) ? await ctx.ledger.all() : [];
    const resumen = buildStatus(enDisco, registros);

    if (resumen.rows.length === 0) {
      ctx.logger.warn(`No hay seeders en ${ctx.config.seedersDir} ni nada registrado.`);
      return;
    }

    for (const linea of formatear(resumen)) ctx.logger.info(linea);
  } finally {
    await closeContext(ctx);
  }
}

/** Tabla alineada. Se separa para poder probarla sin base de datos. */
export function formatear(resumen: StatusSummary): string[] {
  const anchoEstado = Math.max(...resumen.rows.map((r) => ETIQUETA[r.state].length));
  const anchoLote = Math.max(4, ...resumen.rows.map((r) => String(r.batch ?? '').length));

  const lineas = resumen.rows.map((row) => {
    const estado = ETIQUETA[row.state].padEnd(anchoEstado);
    const lote = String(row.batch ?? '').padStart(anchoLote);
    const marca = MARCA[row.state];
    return `${marca} ${COLOR[row.state](estado)}  ${pc.dim(lote)}  ${row.name}`;
  });

  const partes = [
    `${resumen.onDisk} en disco`,
    `${resumen.applied} ejecutados`,
    `${resumen.pending} pendientes`,
  ];
  if (resumen.missingFile > 0) partes.push(`${resumen.missingFile} sin archivo`);

  return [...lineas, '', partes.join(' · ')];
}

const MARCA: Record<SeederStatus['state'], string> = {
  applied: pc.green('✓'),
  pending: pc.dim('·'),
  'missing-file': pc.yellow('!'),
};

const COLOR: Record<SeederStatus['state'], (s: string) => string> = {
  applied: pc.green,
  pending: (s) => s,
  'missing-file': pc.yellow,
};
