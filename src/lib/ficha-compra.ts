// Detalle de compra: datos (PostgREST) + HTML. Igual que la ficha de
// proveedor, lo usan la Pages Function functions/compras/[id].ts (la sirve
// armada) y el script de src/pages/compras/detalle.astro (fallback en dev o
// si la Function no pudo cargar). Sin dependencias, solo `fetch`.

import { int, uyu, cant, moneda, fecha, titulo } from './format.js';
import { estadoCompra, estadoAdjudicacion } from './estados.js';
import { slugEntidad } from './slug.js';
import { nombreOrganismo } from './incisos.js';
import { card, esc, kpi, mensajeHtml as mensajeBase, recortarDescripcion, type FichaArmada } from './ficha-html.js';
import type { Conexion } from './ficha-proveedor.js';

interface Item {
  description: string | null;
  classification_id: string | null;
  classification_desc: string | null;
  quantity: number | null;
  unit_name: string | null;
  amount: number | null;
  currency: string | null;
  amount_uyu: number | null;
}
interface Adjudicacion {
  award_id: string;
  status: string | null;
  award_date: string | null;
  notice_url: string | null;
  supplier: { id: string; name: string } | null;
  items: Item[];
}
interface Compra {
  ocid: string;
  id_compra: number;
  tender_title: string | null;
  tender_description: string | null;
  status: string | null;
  first_seen: string;
  last_updated: string;
  buyer: { id: string; name: string } | null;
  awards: Adjudicacion[];
}
interface Outlier {
  tipo: string;
  nota: string;
}

export type { Conexion };

/** id de compra válido en la URL (o null). */
export function idValido(id: string | null | undefined): string | null {
  return id && /^\d{1,12}$/.test(id) ? id : null;
}

/**
 * «← Compras». En el server siempre va a /compras; el cliente después le
 * cambia el href por la última búsqueda del buscador (sessionStorage).
 */
export const linkVolver = (href = '/compras') =>
  `<a href="${esc(href)}" class="text-sm font-medium text-primary hover:underline">← Compras</a>`;

export const mensajeHtml = (texto: string, hrefVolver?: string) =>
  mensajeBase(linkVolver(hrefVolver), texto);

const filaFicha = (dt: string, dd: string) => `
  <div class="flex justify-between gap-4 border-b border-line pb-2">
    <dt class="text-ink-faint">${dt}</dt>
    <dd class="num text-right">${dd}</dd>
  </div>`;

function render(compra: Compra, outlier: Outlier | null): FichaArmada {
  const adjudicaciones = [...compra.awards].sort((a, b) =>
    (a.award_date ?? '9999').localeCompare(b.award_date ?? '9999'),
  );

  const totalItem = (i: Item) => (i.amount_uyu == null ? null : i.amount_uyu * (i.quantity ?? 1));
  const totalAdj = (a: Adjudicacion) => a.items.reduce((s, i) => s + (totalItem(i) ?? 0), 0);
  const totalCompra = adjudicaciones.reduce((s, a) => s + totalAdj(a), 0);
  const nItems = adjudicaciones.reduce((s, a) => s + a.items.length, 0);

  // Objeto de la compra: el feed solo trae tender.title en los llamados;
  // si falta, usamos el ítem adjudicado de mayor monto como proxy.
  const itemPrincipal = adjudicaciones
    .flatMap((a) => a.items)
    .sort((x, y) => (totalItem(y) ?? -1) - (totalItem(x) ?? -1))
    .map((i) => i.description ?? i.classification_desc)
    .find((d) => d != null);
  const objeto = compra.tender_title ?? itemPrincipal ?? null;

  // Descripción del llamado: texto libre que escribe el organismo, lo único
  // que dice en palabras QUÉ se compró (el título es "Tipo N/AAAA"). ARCE la
  // muestra bajo el título; acá va en el mismo lugar. Solo la traen los
  // releases de llamado: la tiene ~1 de cada 3 compras, y siempre junto al
  // título, así que nunca duplica el h1.
  const descripcion = compra.tender_description;

  const urlArce = `https://www.comprasestatales.gub.uy/consultas/detalle/mostrar-llamado/1/id/${compra.id_compra}`;

  const buyerNombre = compra.buyer ? nombreOrganismo(compra.buyer.name, compra.buyer.id) : null;
  const linkBuyer = compra.buyer
    ? `<a href="/organismos/${esc(slugEntidad(compra.buyer.id))}" class="hover:underline">${esc(buyerNombre!)}</a>`
    : 'organismo sin identificar';

  const cardsAdj = adjudicaciones.length
    ? adjudicaciones
        .map((a) => {
          const filas = a.items
            .map(
              (i) => `
            <tr class="border-b border-line last:border-b-0">
              <td class="max-w-[24rem] truncate py-2.5 pr-4" title="${esc(i.description ?? '')}">${esc(titulo(i.description, 70))}</td>
              <td class="max-w-[16rem] truncate py-2.5 pr-4 text-ink-soft" title="${esc(i.classification_desc ?? '')}">${esc(i.classification_desc ?? i.classification_id ?? '—')}</td>
              <td class="num py-2.5 pr-4 text-right text-ink-soft">${esc(cant(i.quantity))}</td>
              <td class="py-2.5 pr-4 text-ink-soft">${esc(i.unit_name ?? '—')}</td>
              <td class="num py-2.5 pr-4 text-right whitespace-nowrap text-ink-soft">${esc(moneda(i.amount, i.currency))}</td>
              <td class="num py-2.5 text-right whitespace-nowrap">${esc(uyu(totalItem(i)))}</td>
            </tr>`,
            )
            .join('');

          const links = [
            a.supplier
              ? `<a href="/proveedores/${esc(slugEntidad(a.supplier.id))}" class="font-medium text-primary hover:underline">Ficha del proveedor →</a>`
              : '',
            a.notice_url
              ? `<a href="${esc(a.notice_url)}" rel="noopener" target="_blank" class="font-medium text-primary hover:underline">Acta de adjudicación (PDF) →</a>`
              : '',
          ]
            .filter(Boolean)
            .join('');

          return card(
            `Adjudicación · ${a.supplier?.name ?? 'proveedor sin identificar'}`,
            `${fecha(a.award_date)} · ${estadoAdjudicacion(a.status)} · ${int(a.items.length)} ítems`,
            `
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-line text-left text-xs text-ink-faint">
                    <th class="py-2 pr-4 font-medium">Ítem</th>
                    <th class="py-2 pr-4 font-medium">Clasificación</th>
                    <th class="py-2 pr-4 text-right font-medium">Cant.</th>
                    <th class="py-2 pr-4 font-medium">Unidad</th>
                    <th class="py-2 pr-4 text-right font-medium">Precio unit.</th>
                    <th class="py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>${filas}</tbody>
                <tfoot>
                  <tr class="border-t border-line text-xs">
                    <td colspan="5" class="py-2.5 pr-4 text-right font-medium text-ink-faint">Total adjudicación</td>
                    <td class="num py-2.5 text-right font-medium whitespace-nowrap">${esc(uyu(totalAdj(a)))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            ${links ? `<p class="mt-4 flex flex-wrap justify-end gap-x-6 text-sm">${links}</p>` : ''}`,
          );
        })
        .join('')
    : card(
        'Adjudicaciones',
        null,
        '<p class="text-sm text-ink-soft">Esta compra todavía no tiene adjudicaciones registradas en el feed OCDS.</p>',
      );

  const aviso = outlier
    ? `<div class="col-span-12 rounded-lg border border-flag-warn/30 bg-flag-warn/10 px-5 py-4">
        <p class="flex items-start gap-2 text-sm text-flag-warn">
          <span aria-hidden="true" class="shrink-0">⚠</span>
          <span>${esc(outlier.nota)}</span>
        </p>
      </div>`
    : '';

  const html = `
  <div class="col-span-12">
    ${linkVolver()}
    <h1 class="mt-2 text-xl font-semibold tracking-tight">${esc(titulo(objeto, 140))}</h1>
    <p class="mt-1 text-sm text-ink-soft">compra ${compra.id_compra} · ${linkBuyer}</p>
    ${
      descripcion
        ? `<p class="mt-4 max-w-3xl border-l-2 border-line pl-4 text-sm leading-relaxed text-ink-soft">${esc(descripcion)}</p>`
        : ''
    }
  </div>
  ${aviso}
  ${kpi('Adjudicado', uyu(adjudicaciones.length ? totalCompra : null), 'pesos uruguayos, montos normalizados')}
  ${kpi('Adjudicaciones', int(adjudicaciones.length), `${int(nItems)} ítems`)}
  ${kpi('Estado', estadoCompra(compra.status), `actualizada el ${fecha(compra.last_updated)}`)}
  ${card(
    'Ficha',
    'identificadores y fuente del proceso',
    `<dl class="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
      ${filaFicha('Organismo', compra.buyer ? `<a href="/organismos/${esc(slugEntidad(compra.buyer.id))}" class="font-medium text-primary hover:underline">${esc(buyerNombre!)}</a>` : '—')}
      ${filaFicha('ocid', `<span class="text-ink-soft">${esc(compra.ocid)}</span>`)}
      ${filaFicha('Primera vez vista', esc(fecha(compra.first_seen)))}
      ${filaFicha('Última actualización', esc(fecha(compra.last_updated)))}
    </dl>
    <p class="mt-4 text-sm">
      <a href="${esc(urlArce)}" rel="noopener" target="_blank" class="font-medium text-primary hover:underline">Ver en comprasestatales.gub.uy →</a>
    </p>`,
  )}
  ${cardsAdj}`;

  // <title>: el h1 suele ser «Compra Directa 123/2025», que no dice nada en
  // un resultado de Google; en ese caso va lo que se compró.
  const tituloEsTipo = /\d+\/\d{4}\s*$/.test(compra.tender_title ?? '');
  const queSeCompro = (tituloEsTipo ? itemPrincipal : null) ?? objeto;
  const tituloPagina = queSeCompro
    ? `${titulo(queSeCompro, 70)} · compra ${compra.id_compra} · Compras del Estado`
    : `Compra ${compra.id_compra} · Compras del Estado`;

  // Snippet: quién compró, qué, cuánto y a quién. El monto se omite si es
  // un outlier inflado (no representativo, ver lib/outliers.ts).
  const proveedores = [
    ...new Set(adjudicaciones.map((a) => a.supplier?.name).filter((n): n is string => !!n)),
  ];
  const aQuien = proveedores.length
    ? ` a ${proveedores.slice(0, 2).join(' y ')}${proveedores.length > 2 ? ` y ${proveedores.length - 2} más` : ''}`
    : '';
  const cuanto =
    adjudicaciones.length === 0
      ? ' Sin adjudicaciones registradas.'
      : outlier?.tipo === 'monto_inflado'
        ? ` Adjudicada${aQuien}.`
        : ` Adjudicado ${uyu(totalCompra)}${aQuien}.`;
  const que = descripcion ?? queSeCompro;
  const descripcionPagina =
    `Compra ${compra.id_compra} de ${buyerNombre ?? 'organismo sin identificar'}` +
    `${que ? `: ${titulo(que, 60)}.` : '.'}${cuanto} Estado: ${estadoCompra(compra.status)}.`;

  return { titulo: tituloPagina, descripcion: recortarDescripcion(descripcionPagina), html };
}

const SELECT =
  'ocid,id_compra,tender_title,tender_description,status,first_seen,last_updated,' +
  'buyer:entities!purchases_buyer_id_fkey(id,name),' +
  'awards(award_id,status,award_date,notice_url,supplier:entities!awards_supplier_id_fkey(id,name),' +
  'items:award_items(description,classification_id,classification_desc,quantity,unit_name,amount,currency,amount_uyu))';

/** Detalle completo de la compra, o null si no existe. Tira si falla la API. */
export async function cargarCompra(cx: Conexion, id: string): Promise<FichaArmada | null> {
  const headers = { apikey: cx.supabaseKey };
  const [res, resOutlier] = await Promise.all([
    fetch(`${cx.supabaseUrl}/rest/v1/purchases?${new URLSearchParams({ select: SELECT, id_compra: `eq.${id}` })}`, { headers }),
    fetch(`${cx.supabaseUrl}/rest/v1/outliers?${new URLSearchParams({ select: 'tipo,nota', id_compra: `eq.${id}` })}`, { headers }),
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const compras = (await res.json()) as Compra[];
  if (!compras.length) return null;
  // El aviso es accesorio: si su fetch falla, la compra igual se muestra.
  const outlier = resOutlier.ok ? (((await resOutlier.json()) as Outlier[])[0] ?? null) : null;
  return render(compras[0], outlier);
}
