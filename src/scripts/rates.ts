import { supabase, upsertRows } from './db.js';
import { fetchCotizaciones } from './bcu.js';

// ---------------------------------------------------------------------------
// Mapeo moneda OCDS -> código BCU.
// UYU es la base (rate 1) y se resuelve en la normalización, no se consulta.
// ---------------------------------------------------------------------------
const CURRENCIES: Array<{ ocds: string; bcu: number }> = [
  { ocds: 'USD', bcu: 2225 }, // Dólar billete. Para valuación contable se puede usar 2230 (promedio fondo).
  { ocds: 'EUR', bcu: 1111 }, // Euro
  { ocds: 'UYI', bcu: 9800 }, // Unidad Indexada (ISO 4217: UYI)
  { ocds: 'GBP', bcu: 2700 }, // Libra esterlina (código confirmado vía awsbcumonedas)
  // UR (Unidad Reajustable) no tiene código ISO estándar. Si aparece en tus
  // datos, agregá acá su código BCU y su etiqueta tal cual figura en award_items.currency.
];

const codeToOcds = new Map(CURRENCIES.map((c) => [c.bcu, c.ocds]));

interface RateRow {
  rate_date: string;
  currency: string;
  rate_uyu: number;
}

// ---------------------------------------------------------------------------
// Helpers de fechas
// ---------------------------------------------------------------------------

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(date: string, delta: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}

/** Divide [from, to] en ventanas de a lo sumo `days` días (tope del BCU: 31). */
function* windows(from: string, to: string, days = 31): Generator<[string, string]> {
  let start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (start <= end) {
    const wEnd = new Date(start);
    wEnd.setUTCDate(wEnd.getUTCDate() + days - 1);
    const clamped = wEnd > end ? end : wEnd;
    yield [iso(start), iso(clamped)];
    start = new Date(clamped);
    start.setUTCDate(start.getUTCDate() + 1);
  }
}

/** Rango de fechas de adjudicaciones que hay en la base. */
async function awardDateRange(): Promise<{ min: string; max: string } | null> {
  // Un builder por consulta: los builders de supabase-js son mutables y
  // reusar el mismo encadena los .order(), con lo que max terminaría == min.
  const sel = () => supabase.from('awards').select('award_date').not('award_date', 'is', null);

  const { data: minRow, error: e1 } = await sel().order('award_date', { ascending: true }).limit(1).maybeSingle();
  if (e1) throw new Error(`min award_date: ${e1.message}`);
  const { data: maxRow, error: e2 } = await sel().order('award_date', { ascending: false }).limit(1).maybeSingle();
  if (e2) throw new Error(`max award_date: ${e2.message}`);

  if (!minRow?.award_date || !maxRow?.award_date) return null;
  return { min: minRow.award_date as string, max: maxRow.award_date as string };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const range = await awardDateRange();
  if (!range) {
    console.log('No hay adjudicaciones con fecha en la base; nada para cotizar.');
    return;
  }

  // Buffer de 7 días hacia atrás: así la normalización tiene una cotización
  // previa para adjudicaciones caídas en fin de semana o feriado.
  // Clamp defensivo del rango: en ARCE hay award_date rotos (ej. año "0026")
  // que, si se cuelan, dispararían miles de consultas al BCU. Los ISO strings
  // se comparan bien lexicográficamente.
  const FLOOR = '2000-01-01';
  const today = iso(new Date());
  const rawFrom = shiftDays(range.min, -7);
  const from = rawFrom < FLOOR ? FLOOR : rawFrom;
  const to = range.max > today ? today : range.max;
  if (from > to) {
    console.log(`  Rango inválido tras el clamp (${from} > ${to}); nada para cotizar.`);
    return;
  }
  const codes = CURRENCIES.map((c) => c.bcu);

  console.log(`\n▶ Cotizaciones BCU ${from} .. ${to}`);
  console.log(`  monedas: ${CURRENCIES.map((c) => `${c.ocds}(${c.bcu})`).join(', ')}\n`);

  const rows: RateRow[] = [];
  for (const [wFrom, wTo] of windows(from, to)) {
    const datos = await fetchCotizaciones(codes, wFrom, wTo);
    for (const d of datos) {
      const ocds = codeToOcds.get(d.code);
      if (!ocds) continue;
      // Guardamos el promedio comprador/vendedor (para UI/UR TCC == TCV).
      rows.push({ rate_date: d.date, currency: ocds, rate_uyu: (d.tcc + d.tcv) / 2 });
    }
    console.log(`  ${wFrom}..${wTo}: ${datos.length} cotizaciones`);
  }

  // Deduplicar por (fecha, moneda) por si las ventanas se solapan.
  const uniq = new Map<string, RateRow>();
  for (const r of rows) uniq.set(`${r.rate_date}:${r.currency}`, r);

  if (uniq.size === 0) {
    console.log('\n  No se obtuvieron cotizaciones (¿rango de feriados o monedas sin datos?).\n');
    return;
  }

  await upsertRows('currency_rates', [...uniq.values()], 'rate_date,currency');
  console.log(`\n✔ ${uniq.size} cotizaciones guardadas en currency_rates.\n`);
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
