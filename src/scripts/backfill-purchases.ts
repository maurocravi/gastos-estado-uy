import { gunzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OcdsRelease } from './ocds.js';
import { texto } from './transform.js';
import { supabase, upsertRows, type PurchaseRow } from './db.js';

// ---------------------------------------------------------------------------
// Backfill de purchases.tender_title / tender_description desde los releases
// que tenemos guardados: los .ndjson.gz de `archivo/` (meses ya archivados)
// más los `releases.raw` que siguen en la base (meses dentro de retención).
//
// Para qué: los dos campos vienen SOLO en el release de llamado y hasta ahora
// el upsert de purchases pisaba la fila entera en cada corrida, así que una
// adjudicación posterior los dejaba en null (compra 1325850, entre otras).
// `mergePurchase` en ingest.ts corta la sangría hacia adelante; esto repara lo
// que ya se perdió y completa la descripción, que es columna nueva.
//
// Regla: por ocid gana el release más reciente que traiga el campo (misma
// semántica que el Accumulator). Nunca escribe null: si no encontramos nada,
// la fila queda como está.
//
// Uso:
//   npm run backfill-purchases            escribe
//   npm run backfill-purchases -- --dry   solo reporta
// ---------------------------------------------------------------------------

const PAGE = 1000; // tope por request de PostgREST
const LOTE_OCIDS = 500; // ocids por request al leer purchases
const DIR = 'archivo';

interface Campo {
  valor: string;
  fecha: string;
}

/** ocid -> mejor título / mejor descripción vistos, con la fecha de su release. */
type Mejores = Map<string, { title?: Campo; description?: Campo }>;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function anotar(mejores: Mejores, release: OcdsRelease): void {
  const ocid = release.ocid;
  if (!ocid) return;
  const title = texto(release.tender?.title);
  const description = texto(release.tender?.description);
  if (!title && !description) return;

  const fecha = release.date ?? '';
  const actual = mejores.get(ocid) ?? {};
  // Todas las fechas vienen del feed en el mismo formato ISO ("...Z"), así que
  // alcanza con comparar como texto.
  if (title && (!actual.title || fecha >= actual.title.fecha)) actual.title = { valor: title, fecha };
  if (description && (!actual.description || fecha >= actual.description.fecha)) {
    actual.description = { valor: description, fecha };
  }
  mejores.set(ocid, actual);
}

/** Releases archivados en disco (una línea JSON por release, campo `raw`). */
function leerArchivo(mejores: Mejores): number {
  let n = 0;
  const archivos = readdirSync(DIR)
    .filter((f) => /^releases-\d{4}-\d{2}\.ndjson\.gz$/.test(f))
    .sort();

  for (const nombre of archivos) {
    const lineas = gunzipSync(readFileSync(join(DIR, nombre))).toString().split('\n');
    let delMes = 0;
    for (const linea of lineas) {
      if (!linea) continue;
      const { raw } = JSON.parse(linea) as { raw: OcdsRelease | null };
      if (!raw) continue;
      anotar(mejores, raw);
      delMes++;
    }
    n += delMes;
    console.log(`  ${nombre}: ${delMes} releases`);
  }
  return n;
}

/** Releases que todavía tienen raw en la base (meses sin archivar). */
async function leerBase(mejores: Mejores): Promise<number> {
  let n = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('releases')
      .select('raw')
      .not('raw', 'is', null)
      .order('release_id') // orden total estable: sin esto las páginas se solapan
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leer releases: ${error.message}`);
    for (const r of data ?? []) {
      anotar(mejores, r.raw as OcdsRelease);
      n++;
    }
    if (!data || data.length < PAGE) break;
  }
  return n;
}

async function main() {
  const dry = process.argv.slice(2).includes('--dry');
  console.log(`\n▶ Backfill de título y descripción de compras${dry ? ' (--dry)' : ''}\n`);

  const mejores: Mejores = new Map();
  const enDisco = leerArchivo(mejores);
  const enBase = await leerBase(mejores);
  console.log(
    `\n  Releases leídos: ${enDisco} archivados + ${enBase} en la base.\n` +
      `  Ocids con título o descripción: ${mejores.size}`,
  );
  if (mejores.size === 0) return;

  // Solo escribimos lo que cambia (y solo sobre compras que existen: el upsert
  // insertaría una fila huérfana si el ocid no estuviera).
  const updates: Array<Pick<PurchaseRow, 'ocid' | 'tender_title' | 'tender_description'>> = [];
  let sinCompra = 0;
  let titulos = 0;
  let descripciones = 0;

  for (const lote of chunk([...mejores.keys()], LOTE_OCIDS)) {
    const { data, error } = await supabase
      .from('purchases')
      .select('ocid, tender_title, tender_description')
      .in('ocid', lote);
    if (error) throw new Error(`leer purchases: ${error.message}`);

    const filas = new Map((data ?? []).map((r) => [r.ocid as string, r]));
    sinCompra += lote.length - filas.size;

    for (const ocid of lote) {
      const fila = filas.get(ocid);
      if (!fila) continue;
      const mejor = mejores.get(ocid)!;
      const title = mejor.title?.valor ?? null;
      const description = mejor.description?.valor ?? null;

      const nuevoTitulo = title !== null && title !== fila.tender_title;
      const nuevaDesc = description !== null && description !== fila.tender_description;
      if (!nuevoTitulo && !nuevaDesc) continue;
      if (nuevoTitulo) titulos++;
      if (nuevaDesc) descripciones++;

      updates.push({
        ocid,
        // null no pisa: si no tenemos valor, mandamos el que ya está.
        tender_title: title ?? fila.tender_title,
        tender_description: description ?? fila.tender_description,
      });
    }
  }

  console.log(
    `  Filas a actualizar: ${updates.length} (${titulos} títulos, ${descripciones} descripciones)` +
      `${sinCompra ? `; ${sinCompra} ocids sin fila en purchases (salteados)` : ''}`,
  );

  if (dry || updates.length === 0) {
    console.log(`\n${dry ? '  (--dry: no se escribió nada)' : '  Nada para escribir.'}\n`);
    return;
  }

  console.log('\n  Escribiendo...');
  // upsert con onConflict=ocid: los ocids ya existen, así que solo actualiza
  // las dos columnas del payload.
  await upsertRows('purchases', updates, 'ocid');
  console.log(`\n✔ Listo. ${updates.length} compras actualizadas.\n`);
  console.log('  Acordate de refrescar las vistas: select refresh_dash();\n');
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
