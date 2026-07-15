import { supabase, upsertRows } from './db.js';

// ---------------------------------------------------------------------------
// Paso 3: normalización de montos.
//
// Completa award_items.amount_uyu / amount_usd a partir de amount + currency
// y las cotizaciones guardadas en currency_rates (paso 2).
//
// Regla: amount_uyu = amount * rate(currency, fecha)   (UYU -> rate 1)
//        amount_usd = amount_uyu / rate('USD', fecha)
// Para cotizaciones se usa la del día de la adjudicación, o la anterior más
// cercana (fin de semana / feriado). Por eso el paso 2 trae un buffer de días.
//
// Uso:
//   npm run normalize            solo items sin amount_uyu (pendientes)
//   npm run normalize -- --force recalcula todos (ej: tras recargar rates)
// ---------------------------------------------------------------------------

const PAGE = 1000; // tope por request de PostgREST
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Tabla de cotizaciones en memoria: currency -> [{date, rate}] ascendente
// ---------------------------------------------------------------------------

type Curve = Array<{ date: string; rate: number }>;

async function loadRates(): Promise<Map<string, Curve>> {
  const curves = new Map<string, Curve>();

  // Paginado: PostgREST devuelve como mucho 1000 filas por request, y la
  // tabla puede tener años de cotizaciones. El segundo .order() da un orden
  // total estable para que las páginas no dupliquen ni salteen filas.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('currency_rates')
      .select('rate_date, currency, rate_uyu')
      .order('rate_date', { ascending: true })
      .order('currency', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cargar currency_rates: ${error.message}`);

    for (const r of data ?? []) {
      const cur = r.currency as string;
      const arr = curves.get(cur) ?? [];
      arr.push({ date: r.rate_date as string, rate: Number(r.rate_uyu) });
      curves.set(cur, arr);
    }
    if (!data || data.length < PAGE) break;
  }
  return curves;
}

/**
 * Cotización de `currency` a pesos en `date` (o la anterior más cercana).
 * UYU es la base (1). Devuelve null si no hay ninguna cotización <= date.
 */
function rateOn(curves: Map<string, Curve>, currency: string, date: string): number | null {
  if (currency === 'UYU') return 1;
  const curve = curves.get(currency);
  if (!curve || curve.length === 0) return null;

  // Búsqueda binaria: última entrada con entry.date <= date.
  let lo = 0;
  let hi = curve.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : curve[found].rate;
}

// ---------------------------------------------------------------------------
// Items a normalizar (paginado)
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  award_id: string;
  amount: string | null;
  currency: string | null;
  awards: { award_date: string | null } | { award_date: string | null }[] | null;
}

async function* iterItems(force: boolean): AsyncGenerator<ItemRow[]> {
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('award_items')
      .select('id, award_id, amount, currency, awards(award_date)')
      .not('amount', 'is', null)
      .range(from, from + PAGE - 1);
    if (!force) q = q.is('amount_uyu', null);

    const { data, error } = await q;
    if (error) throw new Error(`leer award_items: ${error.message}`);
    if (!data || data.length === 0) return;
    yield data as ItemRow[];
    if (data.length < PAGE) return;
  }
}

function awardDate(row: ItemRow): string | null {
  const aw = Array.isArray(row.awards) ? row.awards[0] : row.awards;
  return aw?.award_date ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.slice(2).includes('--force');
  console.log(`\n▶ Normalización de montos${force ? ' (--force: recalcula todo)' : ''}\n`);

  const curves = await loadRates();
  if (curves.size === 0) {
    console.log('  No hay cotizaciones en currency_rates. Corré `npm run rates` primero.\n');
    return;
  }
  console.log(`  Cotizaciones cargadas: ${[...curves.keys()].join(', ')} (+ UYU base)`);

  const updates: Array<{ id: string; award_id: string; amount_uyu: number | null; amount_usd: number | null }> = [];
  let seen = 0;
  let noDate = 0;
  const noRate = new Map<string, number>(); // moneda -> cantidad sin cotización

  for await (const page of iterItems(force)) {
    for (const row of page) {
      seen++;
      const amount = row.amount === null ? null : Number(row.amount);
      const currency = row.currency;
      const date = awardDate(row);

      if (amount === null || !currency || !date) {
        if (!date) noDate++;
        updates.push({ id: row.id, award_id: row.award_id, amount_uyu: null, amount_usd: null });
        continue;
      }

      const rate = rateOn(curves, currency, date);
      const usd = rateOn(curves, 'USD', date);

      if (rate === null) {
        noRate.set(currency, (noRate.get(currency) ?? 0) + 1);
        updates.push({ id: row.id, award_id: row.award_id, amount_uyu: null, amount_usd: null });
        continue;
      }

      const amountUyu = amount * rate;
      const amountUsd = usd ? amountUyu / usd : null;
      updates.push({
        id: row.id,
        award_id: row.award_id,
        amount_uyu: round4(amountUyu),
        amount_usd: amountUsd === null ? null : round4(amountUsd),
      });
    }
  }

  console.log(`  Items procesados: ${seen}`);
  if (seen === 0) {
    console.log('\n  Nada pendiente. (Usá --force para recalcular todo.)\n');
    return;
  }

  const converted = updates.filter((u) => u.amount_uyu !== null).length;
  console.log(`  Convertidos: ${converted}; sin fecha: ${noDate}.`);
  for (const [cur, n] of noRate) console.log(`  ⚠ ${n} items en ${cur} sin cotización disponible.`);

  console.log('\n  Escribiendo...');
  // upsert con onConflict=id: como los ids ya existen, solo actualiza las
  // columnas del payload (amount_uyu/amount_usd); el resto queda intacto.
  await upsertRows('award_items', updates, 'id');
  console.log(`\n✔ Listo. ${converted}/${seen} items normalizados.\n`);
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
