import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { supabase, upsertRows } from './db.js';

// ---------------------------------------------------------------------------
// Archivado de releases.raw fuera de la base.
//
// La base free de Supabase tiene 500 MB y releases.raw es por lejos lo más
// pesado (~20 MB/mes). Este script exporta el raw de un mes a
// archivo/releases-YYYY-MM.ndjson.gz (una línea JSON por release), verifica
// el archivo releyéndolo, y recién entonces pone raw = null en la base.
//
// La vista awards_desactualizados ignora los ocids con algún release sin raw
// (no puede juzgar merges incompletos), así que repair deja de cubrir los
// meses archivados: para reparar o backfillear uno, restaurarlo primero.
//
// Uso:
//   npm run archivar -- 2025-03               archiva ese mes
//   npm run archivar -- --restaurar 2025-03   vuelve a cargar el raw desde el archivo
//
// Retención: el mes en curso y los dos anteriores no se pueden archivar
// (el cron diario los ingiere/repara).
// ---------------------------------------------------------------------------

const PAGE = 1000; // tope por request de PostgREST
const DIR = 'archivo';

interface Linea {
  release_id: string;
  ocid: string | null;
  tag: string | null;
  release_date: string | null;
  raw: unknown;
}

function limites(mes: string): { desde: string; hasta: string } {
  const [y, m] = mes.split('-').map(Number);
  const desde = `${mes}-01`;
  const hasta = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { desde, hasta };
}

/** Primer mes archivable hacia atrás: hoy menos 2 meses no entra. */
function mesMinimoRetenido(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 7);
}

function rutaArchivo(mes: string): string {
  return join(DIR, `releases-${mes}.ndjson.gz`);
}

async function contar(mes: string, conRaw: boolean | null): Promise<number> {
  const { desde, hasta } = limites(mes);
  let q = supabase
    .from('releases')
    .select('release_id', { count: 'exact', head: true })
    .gte('release_date', desde)
    .lt('release_date', hasta);
  if (conRaw === true) q = q.not('raw', 'is', null);
  if (conRaw === false) q = q.is('raw', null);
  const { count, error } = await q;
  if (error) throw new Error(`contar releases: ${error.message}`);
  return count ?? 0;
}

async function archivar(mes: string) {
  if (mes >= mesMinimoRetenido()) {
    throw new Error(
      `${mes} está dentro de la retención (mes en curso + 2): el cron todavía lo toca.`,
    );
  }

  const total = await contar(mes, null);
  const sinRaw = await contar(mes, false);
  if (total === 0) throw new Error(`no hay releases con fecha en ${mes}`);
  if (sinRaw === total) {
    console.log(`  ${mes}: los ${total} releases ya están sin raw. Nada que hacer.`);
    return;
  }
  if (sinRaw > 0) {
    console.log(`  ⚠ ${mes}: ${sinRaw}/${total} ya estaban sin raw; se archiva el resto.`);
  }

  // Bajar el mes entero (solo filas que aún tienen raw), con orden total
  // estable para que las páginas no se solapen.
  const { desde, hasta } = limites(mes);
  const lineas: Linea[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('releases')
      .select('release_id, ocid, tag, release_date, raw')
      .gte('release_date', desde)
      .lt('release_date', hasta)
      .not('raw', 'is', null)
      .order('release_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leer releases: ${error.message}`);
    lineas.push(...((data ?? []) as Linea[]));
    if (!data || data.length < PAGE) break;
  }
  if (lineas.length !== total - sinRaw) {
    throw new Error(`bajé ${lineas.length} releases pero esperaba ${total - sinRaw}`);
  }

  // Escribir y verificar el archivo antes de tocar la base.
  mkdirSync(DIR, { recursive: true });
  const ruta = rutaArchivo(mes);
  const ndjson = lineas.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(ruta, gzipSync(Buffer.from(ndjson), { level: 9 }));

  const releido = gunzipSync(readFileSync(ruta)).toString();
  if (releido !== ndjson) throw new Error(`verificación del archivo ${ruta} falló`);
  const mb = (ndjson.length / 1e6).toFixed(1);
  console.log(`  ${ruta}: ${lineas.length} releases (${mb} MB sin comprimir).`);

  // Recién ahora vaciar raw en la base.
  const { error, count } = await supabase
    .from('releases')
    .update({ raw: null }, { count: 'exact' })
    .gte('release_date', desde)
    .lt('release_date', hasta)
    .not('raw', 'is', null);
  if (error) throw new Error(`vaciar raw: ${error.message}`);
  if (count !== lineas.length) {
    throw new Error(`vacié raw de ${count} filas pero archivé ${lineas.length}: revisar a mano`);
  }
  console.log(`  raw vaciado en ${count} filas. ✔`);
}

async function restaurar(mes: string) {
  const ruta = rutaArchivo(mes);
  if (!existsSync(ruta)) throw new Error(`no existe ${ruta}`);

  const lineas = gunzipSync(readFileSync(ruta))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Linea);

  // Solo release_id + raw: el upsert deja el resto de las columnas intacto.
  await upsertRows(
    'releases',
    lineas.map((l) => ({ release_id: l.release_id, raw: l.raw })),
    'release_id',
  );

  const conRaw = await contar(mes, true);
  console.log(`  ${mes}: ${lineas.length} raw restaurados (${conRaw} con raw en la base). ✔`);
  console.log('  Acordate de volver a archivar cuando termines.');
}

async function main() {
  const args = process.argv.slice(2);
  const modoRestaurar = args.includes('--restaurar');
  const mes = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  if (!mes) {
    console.error('Uso: npm run archivar -- [--restaurar] YYYY-MM');
    process.exit(1);
  }

  console.log(`\n▶ ${modoRestaurar ? 'Restauración' : 'Archivado'} de releases.raw ${mes}\n`);
  await (modoRestaurar ? restaurar(mes) : archivar(mes));
  console.log();
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
