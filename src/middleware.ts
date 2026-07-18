import { defineMiddleware } from 'astro:middleware';

// Replica en el dev server los rewrites de public/_redirects (Cloudflare
// Pages): /compras/{id} y /proveedores/{slug} sirven las páginas únicas de
// detalle sin cambiar la URL. En el build estático esto no afecta a prod.
export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;
  if (/^\/compras\/(?!detalle\/?$)[^/]+\/?$/.test(pathname)) {
    return context.rewrite('/compras/detalle/');
  }
  if (/^\/proveedores\/(?!detalle\/?$)[^/]+\/?$/.test(pathname)) {
    return context.rewrite('/proveedores/detalle/');
  }
  return next();
});
