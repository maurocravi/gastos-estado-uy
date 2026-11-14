// Sirve una ficha armada en el servidor a partir de la cáscara client-side
// del build. Lo comparten /proveedores/{slug} y /compras/{id}.
//
// Las fichas eran cáscaras (rewrite de _redirects a /…/detalle/): el HTML
// traía un título genérico y «Cargando…», sin canonical, y 200 aun para ids
// inexistentes. Google las mostró unos días y después las dejó caer. Acá se
// toma la misma cáscara (layout, CSS y scripts del build) y se le inyecta:
//   - <title>, description y Open Graph de la ficha;
//   - canonical al dominio sin www;
//   - el contenido dentro del contenedor, marcado con data-ssr para que el
//     script de cliente no lo vuelva a pedir;
//   - 404 real si la ficha no existe.
// Si Supabase falla devuelve la cáscara sin tocar y el cliente reintenta.

import { esc, type FichaArmada } from '../../src/lib/ficha-html';
import type { Conexion } from '../../src/lib/ficha-proveedor';

export interface Env {
  ASSETS: Fetcher;
}

export interface Opciones {
  /** Ruta de la cáscara en el build, p. ej. '/compras/detalle/'. */
  cascara: string;
  /** id del contenedor de la ficha en la cáscara. */
  contenedor: string;
  /** Segmento de URL → id normalizado, o null si no es válido. */
  validar: (segmento: string) => string | null;
  /** Path canónico (sin dominio ni barra final) para un id válido. */
  path: (id: string) => string;
  /** Datos + HTML; null si no existe. Tira si falla la API. */
  cargar: (cx: Conexion, id: string) => Promise<FichaArmada | null>;
}

const SITIO = 'https://comprasestadouy.com';
/** Los datos cambian una vez por día (cron 08:00 UTC): 6 h en el edge alcanza. */
const EDGE_SEG = 6 * 3600;
const NAVEGADOR_SEG = 3600;
const TIPO_HTML = 'text/html; charset=utf-8';

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
    headers: { 'content-type': TIPO_HTML, 'cache-control': 'no-store' },
  });
}

export function servirFicha(op: Opciones): PagesFunction<Env, 'id'> {
  return async (ctx) => {
    const { request, env, params } = ctx;
    const crudo = String(params.id);
    // La cáscara misma y los métodos que no son de lectura siguen de largo.
    if (crudo === 'detalle' || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return ctx.next();
    }

    const url = new URL(request.url);
    let id: string | null;
    try {
      id = op.validar(decodeURIComponent(crudo));
    } catch {
      id = null; // %-encoding inválido
    }
    if (!id) return noEncontrado(env, url);

    const cascara = await (await env.ASSETS.fetch(new URL(op.cascara, url))).text();

    const cache = caches.default;
    const clave = await claveCache(url, cascara);
    const cacheada = await cache.match(clave);
    if (cacheada) return cacheada;

    const supabaseUrl = atributo(cascara, 'data-supabase-url');
    const supabaseKey = atributo(cascara, 'data-supabase-key');

    let cargada: FichaArmada | null;
    try {
      if (!supabaseUrl || !supabaseKey) throw new Error('la cáscara no trae la conexión');
      cargada = await op.cargar({ supabaseUrl, supabaseKey }, id);
    } catch (e) {
      console.error(`${url.pathname}: ${e instanceof Error ? e.message : e}`);
      // Fallback: la cáscara de siempre, el cliente lo intenta de nuevo.
      return new Response(cascara, { headers: { 'content-type': TIPO_HTML, 'cache-control': 'no-store' } });
    }
    if (!cargada) return noEncontrado(env, url);
    const ficha = cargada;

    const canonical = `${SITIO}${op.path(id)}`;
    const contenido = (valor: string) => ({
      element(el: Element) {
        el.setAttribute('content', valor);
      },
    });

    const armada = new HTMLRewriter()
      .on('title', { element: (el) => void el.setInnerContent(ficha.titulo) })
      .on('meta[name="description"]', contenido(ficha.descripcion))
      .on('meta[property="og:title"]', contenido(ficha.titulo))
      .on('meta[name="twitter:title"]', contenido(ficha.titulo))
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
      .on(`#${op.contenedor}`, {
        element(el) {
          el.setAttribute('data-ssr', '1');
          el.setInnerContent(ficha.html, { html: true });
        },
      })
      .transform(
        new Response(cascara, {
          headers: {
            'content-type': TIPO_HTML,
            'cache-control': `public, max-age=${NAVEGADOR_SEG}, s-maxage=${EDGE_SEG}`,
          },
        }),
      );

    // El HTMLRewriter es streaming: se materializa una vez para cachear y servir.
    const respuesta = new Response(await armada.text(), armada);
    ctx.waitUntil(cache.put(clave, respuesta.clone()));
    return respuesta;
  };
}
