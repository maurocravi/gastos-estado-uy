import pLimit from 'p-limit';
import { config } from './config.js';
import { fetchMonthlyReleaseList, fetchRelease } from './ocds.js';
import { Accumulator } from './transform.js';
import {
  upsertRows,
  insertRows,
  deleteAwardsForOcids,
  type ReleaseRow,
  type AwardRow,
  type AwardItemRow,
} from './db.js';

// ---------------------------------------------------------------------------
// CLI: [YYYY-MM] [--limit N]
//   sin argumentos -> mes anterior completo
//   --limit N      -> procesa solo los primeros N releases (para probar rápido)
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let month: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') limit = Number(args[++i]);
    else if (a.startsWith('--limit=')) limit = Number(a.split('=')[1]);
    else if (/^\d{4}-\d{2}$/.test(a)) month = a;
  }

  let year: number;
  let mon: number;
  if (month) {
    const [y, m] = month.split('-').map(Number);
    year = y;
    mon = m;
  } else {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    year = prev.getFullYear();
    mon = prev.getMonth() + 1;
  }

  return { year, mon, limit };
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const { year, mon, limit } = parseArgs();
  const mm = String(mon).padStart(2, '0');
  console.log(`\n▶ Ingesta de ${year}-${mm}${limit ? ` (limit ${limit})` : ''}\n`);

  // 1. Lista de releases del mes
  const entries = await fetchMonthlyReleaseList(year, mon);
  const selected = limit ? entries.slice(0, limit) : entries;
  console.log(`  ${entries.length} releases en el feed; procesando ${selected.length}.`);
  if (selected.length === 0) {
    console.log('  Nada para hacer.');
    return;
  }

  // 2. Traer cada release (N+1) con concurrencia acotada
  const acc = new Accumulator();
  const releaseRows: ReleaseRow[] = [];
  const limitFn = pLimit(config.fetchConcurrency);
  let done = 0;
  let failed = 0;

  await Promise.all(
    selected.map((entry) =>
      limitFn(async () => {
        try {
          const release = await withRetry(() => fetchRelease(entry.releaseId));
          if (release) {
            acc.add(release);
            releaseRows.push({
              release_id: entry.releaseId,
              ocid: release.ocid ?? null,
              tag: entry.tag || release.tag?.[0] || null,
              release_date: release.date ?? null,
              raw: release,
            });
          }
        } catch (err) {
          failed++;
          console.warn(`  ⚠ falló ${entry.releaseId}: ${(err as Error).message}`);
        } finally {
          done++;
          if (done % 100 === 0) console.log(`  ...${done}/${selected.length}`);
        }
      }),
    ),
  );

  console.log(`\n  Fetch listo: ${done - failed} ok, ${failed} con error.`);

  // 3. Aplanar adjudicaciones e items
  const awardRows: AwardRow[] = [];
  const itemRows: AwardItemRow[] = [];
  const awardOcids = new Set<string>();
  for (const { award, items } of acc.awards.values()) {
    awardRows.push(award);
    itemRows.push(...items);
    awardOcids.add(award.ocid);
  }

  console.log(
    `  A escribir: ${acc.entities.size} entidades, ${acc.purchases.size} compras, ` +
      `${awardRows.length} adjudicaciones, ${itemRows.length} items.`,
  );

  // 4. Escribir a Supabase en orden de dependencias (FKs)
  console.log('\n  Escribiendo...');
  await upsertRows('entities', [...acc.entities.values()], 'id');
  await upsertRows('purchases', [...acc.purchases.values()], 'ocid');

  // Re-ejecutable: borramos adjudicaciones de los ocids de esta corrida y reinsertamos
  await deleteAwardsForOcids([...awardOcids]);
  await insertRows('awards', awardRows);
  await insertRows('award_items', itemRows);

  await upsertRows('releases', releaseRows, 'release_id');

  console.log(`\n✔ Listo. Mes ${year}-${mm} ingestado.\n`);
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
