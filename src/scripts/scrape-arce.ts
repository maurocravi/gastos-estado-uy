import pLimit from 'p-limit';
import { supabase, upsertRows } from './db.js';

// ---------------------------------------------------------------------------
// Título y descripción desde la ficha HTML de ARCE.
//
// Por qué: `tender.title` y `tender.description` vienen SOLO en los releases
// de llamado del feed OCDS, y 2 de cada 3 compras nunca publican uno (aparecen
// directo como adjudicación, cuyo release no trae bloque `tender`). La ficha
// web de ARCE sí los muestra para todas: el objeto de la compra está en
// `<p class="buy-object">` y el título ("Compra Directa 4451/2026") en el
// `<h2>`. Verificado contra el feed: `ocds/release/llamado-{id}` da 404 para
// esas compras.
//
// Marca `purchases.scraped_at` en cada ficha leída (con o sin datos), así la
// corrida siguiente no la vuelve a pedir. Es incremental y reanudable: si se
// corta, se sigue donde iba.
//
// Uso:
//   npm run scrape                      todas las pendientes
//   npm run scrape -- --limit 3000      tope de fichas (el cron usa esto)
//   npm run scrape -- --concurrencia 4  más suave con el servidor de ARCE
// ---------------------------------------------------------------------------

const FICHA = 'https://www.comprasestatales.gub.uy/consultas/detalle/mostrar-llamado/1/id/';
const LOTE = 500; // compras por vuelta: se piden, se parsean y se escriben juntas

interface Pendiente {
  ocid: string;
  id_compra: number;
  tender_title: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const num = (flag: string, def: number) => {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
    const inline = args.find((a) => a.startsWith(`${flag}=`));
    return inline ? Number(inline.split('=')[1]) : def;
  };
  return { limit: num('--limit', Infinity), concurrencia: num('--concurrencia', 8) };
}

// ---------------------------------------------------------------------------
// Parseo de la ficha
// ---------------------------------------------------------------------------

// La ficha escapa la puntuación con entidades con nombre (`&sol;` por "/") y
// deja los acentos en UTF-8. En un muestreo de 300 fichas dentro de los dos
// campos solo aparecieron `&sol;` y `&nbsp;`; el resto está para no romper si
// ARCE cambia el escapador, y las que no conozcamos se cuentan y se avisan.
const ENTIDADES: Record<string, string> = {
  nbsp: ' ', sol: '/', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  num: '#', percnt: '%', plus: '+', minus: '-', equals: '=', ast: '*',
  comma: ',', period: '.', colon: ':', semi: ';', excl: '!', quest: '?',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}',
  commat: '@', dollar: '$', deg: '°', ordm: 'º', orda: 'ª', middot: '·',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
};

const desconocidas = new Map<string, number>();

function decodificar(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (todo, cuerpo: string) => {
    if (cuerpo.startsWith('#')) {
      const cod = cuerpo[1] === 'x' || cuerpo[1] === 'X'
        ? parseInt(cuerpo.slice(2), 16)
        : parseInt(cuerpo.slice(1), 10);
      return Number.isFinite(cod) ? String.fromCodePoint(cod) : todo;
    }
    const val = ENTIDADES[cuerpo];
    if (val !== undefined) return val;
    desconocidas.set(todo, (desconocidas.get(todo) ?? 0) + 1);
    return todo;
  });
}

/** Texto plano de un fragmento de la ficha, o null si queda vacío. */
function limpiar(html: string | undefined): string | null {
  if (!html) return null;
  // \s de JS incluye el   en que se decodifica &nbsp;, así que el trim
  // final se lleva los que ARCE cuelga al final del título.
  const t = decodificar(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

export function parseFicha(html: string): { title: string | null; description: string | null } {
  return {
    // El <h2> es "Compra Directa 4451/2026 <span class="small">organismo</span>":
    // cortamos en el span para no pegarle el organismo al título.
    title: limpiar(html.match(/<h2>([\s\S]*?)(?:<span|<\/h2>)/)?.[1]),
    description: limpiar(html.match(/<p class="buy-object">([\s\S]*?)<\/p>/)?.[1]),
  };
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

interface Resultado {
  ocid: string;
  title: string | null;
  description: string | null;
  ok: boolean; // false = no pudimos leer la ficha; se reintenta en otra corrida
}

async function bajarFicha(p: Pendiente): Promise<Resultado> {
  const vacio = { ocid: p.ocid, title: null, description: null };
  for (let intento = 0; intento < 3; intento++) {
    try {
      const res = await fetch(FICHA + p.id_compra, {
        headers: { 'User-Agent': 'compras-estado-uy (datos abiertos)' },
        signal: AbortSignal.timeout(30_000),
      });
      // Un 404 es definitivo (la compra no está publicada): lo damos por leído
      // para no volver a pedirlo en cada corrida.
      if (res.status === 404) return { ...vacio, ok: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ...vacio, ...parseFicha(await res.text()), ok: true };
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
    }
  }
  return { ...vacio, ok: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Siguiente lote de compras sin descripción y sin ficha leída. Avanzamos por
 * `id_compra` en vez de repedir "las primeras pendientes": así un lote que
 * falle entero no deja la corrida girando sobre las mismas filas.
 */
async function siguienteLote(desde: number): Promise<Pendiente[]> {
  const { data, error } = await supabase
    .from('purchases')
    .select('ocid, id_compra, tender_title')
    .is('tender_description', null)
    .is('scraped_at', null)
    .gt('id_compra', desde)
    .order('id_compra')
    .limit(LOTE);
  if (error) throw new Error(`leer purchases: ${error.message}`);
  return (data ?? []) as Pendiente[];
}

async function main() {
  const { limit, concurrencia } = parseArgs();
  console.log(`\n▶ Fichas de ARCE (concurrencia ${concurrencia}${limit === Infinity ? '' : `, tope ${limit}`})\n`);

  const { count: pendientes } = await supabase
    .from('purchases')
    .select('ocid', { count: 'exact', head: true })
    .is('tender_description', null)
    .is('scraped_at', null);
  const total = Math.min(pendientes ?? 0, limit);
  console.log(`  Pendientes: ${pendientes ?? 0}${limit === Infinity ? '' : ` (se procesan ${total})`}`);
  if (total === 0) {
    console.log('\n  Nada para hacer. ✔\n');
    return;
  }

  const limitFn = pLimit(concurrencia);
  const t0 = Date.now();
  let desde = 0;
  let leidas = 0;
  let conDesc = 0;
  let conTit = 0;
  let fallidas = 0;

  while (leidas < total) {
    const lote = (await siguienteLote(desde)).slice(0, total - leidas);
    if (lote.length === 0) break;
    desde = lote[lote.length - 1].id_compra;

    const res = await Promise.all(lote.map((p) => limitFn(() => bajarFicha(p))));

    // Solo escribimos las que pudimos leer: las que fallaron por red quedan sin
    // scraped_at y las toma la corrida siguiente.
    const previo = new Map(lote.map((p) => [p.ocid, p]));
    const filas = res
      .filter((r) => r.ok)
      .map((r) => {
        if (r.description) conDesc++;
        if (r.title) conTit++;
        return {
          ocid: r.ocid,
          // null no pisa: el título que ya venía del feed manda.
          tender_title: previo.get(r.ocid)?.tender_title ?? r.title,
          tender_description: r.description,
          scraped_at: new Date().toISOString(),
        };
      });
    fallidas += res.length - filas.length;
    if (filas.length) await upsertRows('purchases', filas, 'ocid');

    leidas += lote.length;
    const ritmo = leidas / ((Date.now() - t0) / 1000);
    const faltan = (total - leidas) / ritmo;
    console.log(
      `  ${leidas}/${total} · ${conDesc} descripciones · ${ritmo.toFixed(1)}/s · ` +
        `quedan ~${faltan > 90 ? `${Math.round(faltan / 60)} min` : `${Math.round(faltan)} s`}`,
    );
  }

  const min = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n✔ Listo en ${min} min. ${leidas} fichas leídas: ${conDesc} descripciones, ${conTit} títulos nuevos.`);
  if (fallidas) console.log(`  ${fallidas} fichas no se pudieron leer; quedan pendientes para la próxima corrida.`);
  if (desconocidas.size) {
    console.log(`  ⚠ entidades HTML sin decodificar: ${[...desconocidas].map(([e, n]) => `${e} (${n})`).join(', ')}`);
  }
  console.log('\n  El título alimenta dash_compras (tipo y buscador): correr `npm run normalize` o `select refresh_dash();`\n');
}

main().catch((err) => {
  console.error('\n✖ Error fatal:', err);
  process.exit(1);
});
