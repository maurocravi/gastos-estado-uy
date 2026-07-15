import type { OcdsRelease } from './ocds.js';
import { Accumulator } from './transform.js';
import {
  supabase,
  insertRows,
  deleteAwardsForOcids,
  type AwardRow,
  type AwardItemRow,
} from './db.js';

// ---------------------------------------------------------------------------
// Reparación de adjudicaciones desde releases.raw (sin tocar el feed de ARCE).
//
// La vista awards_desactualizados compara cada award de la base contra el
// release más reciente que lo menciona; acá reconstruimos esos ocids pasando
// todos sus releases guardados por el Accumulator (que resuelve por fecha de
// release) y reescribimos awards + items. Cierra el ciclo de cualquier corrida
// vieja que haya pisado datos más nuevos (carrera de concurrencia en el
// ingest, o re-ingesta de un mes viejo después de uno nuevo).
//
// Uso:
//   npm run repair                 repara lo que liste awards_desactualizados
//   npm run repair -- <ocid...>    repara esos ocids puntuales
//
// Después: npm run rates && npm run normalize (los items reinsertados quedan
// con amount_uyu null y el normalize incremental los completa).
// ---------------------------------------------------------------------------

const PAGE = 1000; // tope por request de PostgREST
const OCIDS_POR_LOTE = 100; // ocids por request al traer releases

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function ocidsDesactualizados(): Promise<string[]> {
  const ocids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('awards_desactualizados')
      .select('ocid')
      .order('ocid')
      .order('award_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leer awards_desactualizados: ${error.message}`);
    for (const r of data ?? []) ocids.add(r.ocid as string);
    if (!data || data.length < PAGE) break;
  }
  return [...ocids];
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  console.log('\n▶ Reparación de adjudicaciones desde releases.raw\n');

  const ocids = args.length ? args : await ocidsDesactualizados();
  if (ocids.length === 0) {
    console.log('  Nada desactualizado. ✔\n');
    return;
  }
  console.log(`  Ocids a reconstruir: ${ocids.length}`);

  // Todos los releases guardados de esos ocids -> Accumulator (el merge por
  // fecha de release hace irrelevante el orden de lectura).
  const acc = new Accumulator();
  let releases = 0;
  for (const lote of chunk(ocids, OCIDS_POR_LOTE)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('releases')
        .select('raw')
        .in('ocid', lote)
        .order('release_id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`leer releases: ${error.message}`);
      for (const r of data ?? []) {
        acc.add(r.raw as OcdsRelease);
        releases++;
      }
      if (!data || data.length < PAGE) break;
    }
  }
  console.log(`  Releases procesados: ${releases}`);

  // Solo awards e items: entities ya existen y purchases tiene su propio
  // backfill SQL; acá no queremos pisar nada más.
  const awardRows: AwardRow[] = [];
  const itemRows: AwardItemRow[] = [];
  for (const { award, items } of acc.awards.values()) {
    awardRows.push(award);
    itemRows.push(...items);
  }
  console.log(`  A reescribir: ${awardRows.length} adjudicaciones, ${itemRows.length} items.`);

  console.log('\n  Escribiendo...');
  await deleteAwardsForOcids(ocids);
  await insertRows('awards', awardRows);
  await insertRows('award_items', itemRows);

  console.log('\n✔ Listo. Ahora: npm run rates && npm run normalize\n');
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
