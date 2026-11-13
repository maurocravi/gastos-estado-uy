// Ficha de proveedor: datos (PostgREST) + HTML. Lo usan dos lados:
//   - la Pages Function functions/proveedores/[id].ts, que la sirve ya
//     armada (Google y cualquier crawler ven nombre, montos y tablas en el
//     HTML, no una cáscara «Cargando…»);
//   - el script de cliente de src/pages/proveedores/detalle.astro, como
//     fallback (dev local sin Functions, o si la Function no pudo cargar).
// Sin dependencias y solo con `fetch`: corre igual en el navegador y en el
// runtime de Workers.

import { int, uyu, uyuM, pct, fecha, titulo } from './format.js';
import { slugEntidad } from './slug.js';
import { nombreOrganismo } from './incisos.js';
import { etiquetaOutlier } from './outliers.js';

interface Adjudicacion {
  ocid: string;
  id_compra: number | null;
  buyer_id: string | null;
  award_date: string | null;
  total_uyu: number | null;
}
interface CompraResumen {
  ocid: string;
  tender_title: string | null;
  item_principal: string | null;
  organismo: string | null;
  buyer_id: string | null;
  outlier: string | null;
}
interface CompraGanada {
  ocid: string;
  id_compra: number | null;
  buyer_id: string | null;
  fecha: string | null;
  adjudicaciones: number;
  total_uyu: number;
}
interface Cliente {
  id: string;
  adjudicaciones: number;
  total_uyu: number;
}
export interface Entidad {
  id: string;
  name: string;
}

export interface Ficha {
  entidad: Entidad;
  /** Contenido de #ficha. */
  html: string;
  /** Para <meta name="description"> y Open Graph. */
  descripcion: string;
}

export interface Conexion {
  supabaseUrl: string;
  supabaseKey: string;
}

const TOP_CLIENTES = 15;
const TOP_COMPRAS = 50;
const PAGINA = 1000; // tope de filas top-level de PostgREST

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Segmento de URL válido para un proveedor (o null). */
export function slugValido(slug: string | null | undefined): string | null {
  return slug && /^[A-Za-z0-9_.~-]+$/.test(slug) ? slug : null;
}

async function pedir<T>(cx: Conexion, recurso: string, params: URLSearchParams): Promise<T> {
  const res = await fetch(`${cx.supabaseUrl}/rest/v1/${recurso}?${params}`, {
    headers: { apikey: cx.supabaseKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * slug de URL → entidad. Para casi todos los ids el slug es el id mismo;
 * los proveedores extranjeros con caracteres raros (colapsados a "~") se
 * buscan por patrón y se confirma recalculando el slug.
 */
async function resolverEntidad(cx: Conexion, slug: string): Promise<Entidad | null> {
  const directo = await pedir<Entidad[]>(
    cx,
    'entities',
    new URLSearchParams({ select: 'id,name', id: `eq.${slug}` }),
  );
  if (directo.length) return directo[0];
  if (!slug.includes('~')) return null;
  const candidatos = await pedir<Entidad[]>(
    cx,
    'entities',
    // En PostgREST "*" es el comodín de like; "~" reemplazó 1+ caracteres.
    new URLSearchParams({ select: 'id,name', id: `like.${slug.replaceAll('~', '*')}` }),
  );
  return candidatos.find((e) => slugEntidad(e.id) === slug) ?? null;
}

async function adjudicacionesDe(cx: Conexion, supplierId: string): Promise<Adjudicacion[]> {
  const filas: Adjudicacion[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const pagina = await pedir<Adjudicacion[]>(
      cx,
      'dash_adjudicaciones',
      new URLSearchParams({
        select: 'ocid,id_compra,buyer_id,award_date,total_uyu',
        supplier_id: `eq.${supplierId}`,
        order: 'award_pk',
        limit: String(PAGINA),
        offset: String(desde),
      }),
    );
    filas.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return filas;
}

const enLista = (valores: string[]) => `in.(${valores.map((v) => `"${v}"`).join(',')})`;

const kpi = (label: string, value: string, sub: string) => `
  <div class="rounded-lg border border-line bg-surface px-6 py-5 col-span-12 sm:col-span-4">
    <p class="text-xs font-medium tracking-wide text-ink-soft uppercase">${esc(label)}</p>
    <p class="num mt-2 text-2xl font-medium text-ink">${esc(value)}</p>
    <p class="mt-1 text-xs text-ink-faint">${esc(sub)}</p>
  </div>`;

const card = (title: string, sub: string, cuerpo: string) => `
  <section class="rounded-lg border border-line bg-surface p-6 col-span-12">
    <header class="mb-5">
      <h2 class="text-sm font-semibold text-ink">${esc(title)}</h2>
      <p class="mt-0.5 text-xs text-ink-faint">${esc(sub)}</p>
    </header>
    ${cuerpo}
  </section>`;

const volver =
  '<a href="/proveedores" class="text-sm font-medium text-primary hover:underline">← Proveedores</a>';

/** Contenido de #ficha para un estado sin datos (cargando, error, no encontrado). */
export function mensajeHtml(texto: string): string {
  return `
  <div class="col-span-12">
    ${volver}
    <p class="mt-2 text-sm text-ink-soft">${esc(texto)}</p>
  </div>`;
}

function render(
  entidad: Entidad,
  adjudicaciones: Adjudicacion[],
  compraPorOcid: Map<string, CompraResumen>,
  nombrePorId: Map<string, string>,
  clientes: Cliente[],
  compras: CompraGanada[],
): Ficha {
  const totalUyu = adjudicaciones.reduce((s, a) => s + (a.total_uyu ?? 0), 0);
  const topClientes = clientes.slice(0, TOP_CLIENTES);
  const topCompras = compras.slice(0, TOP_COMPRAS);
  const organismo = (id: string) => nombreOrganismo(nombrePorId.get(id) ?? id, id) ?? id;

  const filasClientes = topClientes
    .map(
      (c, i) => `
      <tr class="border-b border-line last:border-b-0">
        <td class="num py-2.5 pr-4 text-xs text-ink-faint">${i + 1}</td>
        <td class="max-w-[30rem] truncate py-2.5 pr-4" title="${esc(organismo(c.id))}">
          <a href="/organismos/${esc(slugEntidad(c.id))}" class="hover:underline">${esc(organismo(c.id))}</a>
        </td>
        <td class="num py-2.5 pr-4 text-right text-ink-soft">${esc(int(c.adjudicaciones))}</td>
        <td class="num py-2.5 pr-4 text-right whitespace-nowrap">${esc(uyu(c.total_uyu))}</td>
        <td class="num py-2.5 text-right text-ink-soft">${esc(pct(totalUyu ? c.total_uyu / totalUyu : null))}</td>
      </tr>`,
    )
    .join('');

  const cardClientes = card(
    'Principales clientes',
    `top ${topClientes.length} de ${int(clientes.length)} organismos por monto adjudicado`,
    topClientes.length === 0
      ? '<p class="text-sm text-ink-soft">Este proveedor todavía no tiene adjudicaciones registradas en el feed OCDS.</p>'
      : `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs text-ink-faint">
              <th class="py-2 pr-4 font-medium">#</th>
              <th class="py-2 pr-4 font-medium">Organismo</th>
              <th class="py-2 pr-4 text-right font-medium">Adjudicaciones</th>
              <th class="py-2 pr-4 text-right font-medium">Total</th>
              <th class="py-2 text-right font-medium">% del proveedor</th>
            </tr>
          </thead>
          <tbody>${filasClientes}</tbody>
        </table>
      </div>`,
  );

  const filasCompras = topCompras
    .map((c) => {
      const compra = compraPorOcid.get(c.ocid);
      const objeto = compra ? (compra.item_principal ?? compra.tender_title) : null;
      const nombreOrg = nombreOrganismo(compra?.organismo ?? null, c.buyer_id);
      const etq = etiquetaOutlier(compra?.outlier);
      const badge = etq
        ? `<span class="ml-1 cursor-help text-flag-warn" title="${esc(etq)}" aria-label="${esc(etq)}">⚠</span>`
        : '';
      // Los inflados vienen con total NULL en dash_adjudicaciones (suman 0):
      // mostramos «—», no «$ 0».
      const monto = compra?.outlier === 'monto_inflado' ? '—' : uyu(c.total_uyu);
      return `
      <tr class="border-b border-line last:border-b-0">
        <td class="num py-2.5 pr-4 whitespace-nowrap">
          ${
            c.id_compra != null
              ? `<a href="/compras/${c.id_compra}" class="font-medium text-primary hover:underline">${c.id_compra}</a>`
              : '—'
          }
        </td>
        <td class="max-w-[24rem] truncate py-2.5 pr-4" title="${esc(objeto ?? '')}">${esc(titulo(objeto, 70))}</td>
        <td class="max-w-[14rem] truncate py-2.5 pr-4 text-ink-soft" title="${esc(nombreOrg ?? '')}">
          ${
            c.buyer_id
              ? `<a href="/organismos/${esc(slugEntidad(c.buyer_id))}" class="hover:underline">${esc(nombreOrg ?? c.buyer_id)}</a>`
              : esc(nombreOrg ?? '—')
          }
        </td>
        <td class="num py-2.5 pr-4 whitespace-nowrap text-ink-soft">${esc(fecha(c.fecha))}</td>
        <td class="num py-2.5 text-right whitespace-nowrap">${esc(monto)}${badge}</td>
      </tr>`;
    })
    .join('');

  const cardCompras = card(
    'Compras en las que fue adjudicado',
    `top ${topCompras.length} de ${int(compras.length)}; el total es lo adjudicado a este proveedor, no toda la compra`,
    topCompras.length === 0
      ? '<p class="text-sm text-ink-soft">Sin adjudicaciones registradas.</p>'
      : `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-line text-left text-xs text-ink-faint">
              <th class="py-2 pr-4 font-medium">Compra</th>
              <th class="py-2 pr-4 font-medium">Objeto</th>
              <th class="py-2 pr-4 font-medium">Organismo</th>
              <th class="py-2 pr-4 font-medium">Fecha</th>
              <th class="py-2 text-right font-medium">Adjudicado</th>
            </tr>
          </thead>
          <tbody>${filasCompras}</tbody>
        </table>
      </div>`,
  );

  const html = `
  <div class="col-span-12">
    ${volver}
    <h1 class="mt-2 text-xl font-semibold tracking-tight">${esc(entidad.name)}</h1>
    <p class="mt-1 text-sm text-ink-soft">proveedor del Estado · id ${esc(entidad.id)}</p>
  </div>
  ${kpi('Adjudicado', uyuM(totalUyu), 'pesos uruguayos, montos normalizados')}
  ${kpi('Adjudicaciones', int(adjudicaciones.length), `en ${int(compras.length)} compras`)}
  ${kpi(
    'Organismos clientes',
    int(clientes.length),
    clientes.length
      ? `el principal concentra ${pct(totalUyu ? clientes[0].total_uyu / totalUyu : null)}`
      : 'sin adjudicaciones registradas',
  )}
  ${cardClientes}
  ${cardCompras}`;

  // Lo que Google muestra como snippet: quién es, cuánto y a quién le vende.
  const descripcion = compras.length
    ? `${entidad.name} (${entidad.id}): ${uyuM(totalUyu)} adjudicados al Estado uruguayo en ` +
      `${int(compras.length)} ${compras.length === 1 ? 'compra' : 'compras'} a ` +
      `${int(clientes.length)} ${clientes.length === 1 ? 'organismo' : 'organismos'}. ` +
      `Principal cliente: ${organismo(clientes[0].id)}.`
    : `${entidad.name} (${entidad.id}): proveedor del Estado uruguayo, sin adjudicaciones registradas en el feed OCDS de ARCE.`;

  return { entidad, html, descripcion };
}

/** Ficha completa del proveedor, o null si el slug no corresponde a ninguno. Tira si falla la API. */
export async function cargarFicha(cx: Conexion, slug: string): Promise<Ficha | null> {
  const entidad = await resolverEntidad(cx, slug);
  if (!entidad) return null;

  const adjudicaciones = await adjudicacionesDe(cx, entidad.id);

  // Ranking de clientes por monto (todas las adjudicaciones).
  const grupos = new Map<string, Cliente>();
  for (const a of adjudicaciones) {
    if (!a.buyer_id) continue;
    const g = grupos.get(a.buyer_id) ?? { id: a.buyer_id, adjudicaciones: 0, total_uyu: 0 };
    g.adjudicaciones += 1;
    g.total_uyu += a.total_uyu ?? 0;
    grupos.set(a.buyer_id, g);
  }
  const clientes = [...grupos.values()].sort((x, y) => y.total_uyu - x.total_uyu);

  // Una fila por compra: un proveedor puede tener varias adjudicaciones
  // en el mismo proceso (ajustes, lotes) y su total no es el de la compra.
  const porCompra = new Map<string, CompraGanada>();
  for (const a of adjudicaciones) {
    const fila = porCompra.get(a.ocid) ?? {
      ocid: a.ocid,
      id_compra: a.id_compra,
      buyer_id: a.buyer_id,
      fecha: null,
      adjudicaciones: 0,
      total_uyu: 0,
    };
    fila.adjudicaciones += 1;
    fila.total_uyu += a.total_uyu ?? 0;
    if (a.award_date && (!fila.fecha || a.award_date > fila.fecha)) fila.fecha = a.award_date;
    porCompra.set(a.ocid, fila);
  }
  const compras = [...porCompra.values()].sort((x, y) => y.total_uyu - x.total_uyu);

  // Nombres y objetos solo para lo que se muestra (top N), no todo.
  const ocidsTop = compras.slice(0, TOP_COMPRAS).map((c) => c.ocid);
  const clientesTop = clientes.slice(0, TOP_CLIENTES).map((c) => c.id);
  const [detalles, nombres] = await Promise.all([
    ocidsTop.length
      ? pedir<CompraResumen[]>(
          cx,
          'dash_compras',
          new URLSearchParams({
            select: 'ocid,tender_title,item_principal,organismo,buyer_id,outlier',
            ocid: enLista(ocidsTop),
          }),
        )
      : Promise.resolve([]),
    clientesTop.length
      ? pedir<Entidad[]>(
          cx,
          'entities',
          new URLSearchParams({ select: 'id,name', id: enLista(clientesTop) }),
        )
      : Promise.resolve([]),
  ]);

  return render(
    entidad,
    adjudicaciones,
    new Map(detalles.map((c) => [c.ocid, c])),
    new Map(nombres.map((e) => [e.id, e.name])),
    clientes,
    compras,
  );
}
