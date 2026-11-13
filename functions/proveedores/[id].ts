// Ficha de proveedor servida ya armada: /proveedores/{slug}.
//
// Hasta acá la ficha era una cáscara client-side (rewrite de _redirects a
// /proveedores/detalle/): el HTML decía «Ficha de proveedor · Compras del
// Estado» y «Cargando proveedor…» para los ~6.000 proveedores, sin nombre ni
// canonical, y devolvía 200 aun para slugs inexistentes. Google las mostró
// unos días y después las dejó caer. Esta Function toma la misma cáscara
// (así el layout, el CSS y los scripts son los del build) y le inyecta:
//   - <title>, description y Open Graph con el nombre y los montos;
//   - canonical al dominio sin www (consolida los duplicados www.);
//   - el contenido de la ficha dentro de #ficha, marcado con data-ssr para
//     que el script de cliente no lo vuelva a pedir;
//   - 404 real si el proveedor no existe.
// Si Supabase falla devuelve la cáscara sin tocar y el cliente reintenta.

import { cargarFicha, esc, slugValido, type Ficha } from '../../src/lib/ficha-proveedor';

interface Env {
  ASSETS: Fetcher;
}

const SITIO = 'https://comprasestadouy.com';
const CASCARA = '/proveedores/detalle/';
/** Los datos cambian una vez por día (cron 08:00 UTC): 6 h en el edge alcanza. */
const EDGE_SEG = 6 * 3600;
const NAVEGADOR_SEG = 3600;

/** Lee un data-* de la cáscara: la publishable key vive en el build, no en la config de Pages. */
function atributo(html: string, nombre: string): string | null {
  const m = html.match(new RegExp(`${nombre}="([^"]*)"`));
  return m ? m[1].replaceAll('&amp;', '&') : null;
}

/**
 * Clave de caché atada al build: el HTML referencia CSS/JS con hash
 * (/_astro/…), que el próximo deploy borra. Si la clave no cambiara con el
 * deploy, una ficha cacheada saldría sin estilos hasta vencer.
 */
async function claveCache(url: URL, cascara: string): Promise<Request> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(cascara));
  const version = [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return new Request(`${url.origin}${url.pathname}?build=${version}`);
}

async function noEncontrado(env: Env, url: URL): Promise<Response> {
  const pagina = await env.ASSETS.fetch(new URL('/404.html', url));
  return new Response(pagina.body, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const onRequest: PagesFunction<Env, 'id'> = async (ctx) => {
  const { request, env, params } = ctx;
  const crudo = String(params.id);
  // La cáscara misma y los métodos que no son de lectura siguen de largo.
  if (crudo === 'detalle' || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return ctx.next();
  }

  const url = new URL(request.url);
  let slug: string | null;
  try {
    slug = slugValido(decodeURIComponent(crudo));
  } catch {
    slug = null; // %-encoding inválido
  }
  if (!slug) return noEncontrado(env, url);

  const respCascara = await env.ASSETS.fetch(new URL(CASCARA, url));
  const cascara = await respCascara.text();

  const cache = caches.default;
  const clave = await claveCache(url, cascara);
  const cacheada = await cache.match(clave);
  if (cacheada) return cacheada;

  const supabaseUrl = atributo(cascara, 'data-supabase-url');
  const supabaseKey = atributo(cascara, 'data-supabase-key');
  const tipoHtml = 'text/html; charset=utf-8';

  let cargada: Ficha | null;
  try {
    if (!supabaseUrl || !supabaseKey) throw new Error('la cáscara no trae la conexión');
    cargada = await cargarFicha({ supabaseUrl, supabaseKey }, slug);
  } catch (e) {
    console.error(`ficha ${slug}: ${e instanceof Error ? e.message : e}`);
    // Fallback: la cáscara de siempre, el cliente lo intenta de nuevo.
    return new Response(cascara, { headers: { 'content-type': tipoHtml, 'cache-control': 'no-store' } });
  }
  if (!cargada) return noEncontrado(env, url);
  const ficha = cargada;

  const titulo = `${ficha.entidad.name} · Compras del Estado`;
  const canonical = `${SITIO}/proveedores/${encodeURIComponent(slug)}`;
  const contenido = (valor: string) => ({
    element(el: Element) {
      el.setAttribute('content', valor);
    },
  });

  const armada = new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(titulo) })
    .on('meta[name="description"]', contenido(ficha.descripcion))
    .on('meta[property="og:title"]', contenido(titulo))
    .on('meta[name="twitter:title"]', contenido(titulo))
    .on('meta[property="og:description"]', contenido(ficha.descripcion))
    .on('meta[name="twitter:description"]', contenido(ficha.descripcion))
    .on('head', {
      element(el) {
        el.append(
          `<link rel="canonical" href="${esc(canonical)}" />` +
            `<meta property="og:url" content="${esc(canonical)}" />`,
          { html: true },
        );
      },
    })
    .on('#ficha', {
      element(el) {
        el.setAttribute('data-ssr', '1');
        el.setInnerContent(ficha.html, { html: true });
      },
    })
    .transform(
      new Response(cascara, {
        headers: {
          'content-type': tipoHtml,
          'cache-control': `public, max-age=${NAVEGADOR_SEG}, s-maxage=${EDGE_SEG}`,
        },
      }),
    );

  // El HTMLRewriter es streaming: se materializa una vez para cachear y servir.
  const cuerpo = await armada.text();
  const respuesta = new Response(cuerpo, armada);
  ctx.waitUntil(cache.put(clave, respuesta.clone()));
  return respuesta;
};
