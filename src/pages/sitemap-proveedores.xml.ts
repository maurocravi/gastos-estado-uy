import type { APIRoute } from 'astro';
import { supabase, unwrap } from '../lib/supabase.js';
import { slugEntidad } from '../lib/slug.js';

// Sitemap de las fichas de proveedor (/proveedores/{slug}). No son páginas
// del build (las sirve la Pages Function functions/proveedores/[id].ts), así
// que @astrojs/sitemap no las ve: este endpoint se prerenderiza en el build
// con la lista de dash_gasto_proveedor (un proveedor por fila, solo los que
// tienen adjudicaciones) y astro.config.mjs lo suma al sitemap-index vía
// `customSitemaps`. ~11k URLs: entra en un archivo (tope del protocolo:
// 50.000 URLs / 50 MB); si se acerca al tope, partirlo.

const PAGINA = 1000; // tope de filas de PostgREST
const TOPE_SITEMAP = 50_000;

const escXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

async function idsProveedores(): Promise<string[]> {
  const ids: string[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const filas = unwrap<{ id: string }[]>(
      await supabase
        .from('dash_gasto_proveedor')
        .select('id')
        .order('id')
        .range(desde, desde + PAGINA - 1),
      'dash_gasto_proveedor (sitemap)',
    );
    ids.push(...filas.map((f) => f.id));
    if (filas.length < PAGINA) break;
  }
  return ids;
}

export const GET: APIRoute = async ({ site }) => {
  const ids = await idsProveedores();
  if (ids.length === 0) throw new Error('sitemap-proveedores: la vista vino vacía');
  if (ids.length > TOPE_SITEMAP) {
    throw new Error(`sitemap-proveedores: ${ids.length} URLs superan el tope de ${TOPE_SITEMAP}; partirlo`);
  }

  // Sin barra final: es la forma del canonical que emite la Function.
  const urls = ids
    .map((id) => `<url><loc>${escXml(new URL(`/proveedores/${slugEntidad(id)}`, site).href)}</loc></url>`)
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};
