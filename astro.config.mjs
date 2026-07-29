// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// Las páginas servidas bajo muchas URLs por los rewrites de `_redirects`
// (el detalle de compra, la ficha de proveedor y el detalle de precios son
// una sola página que lee el id de la URL) NO van al sitemap: la URL que se
// buildea (`/compras/detalle/`) no existe para el visitante y sin parámetros
// no muestra nada. Las URLs reales son 130k y se rastrean por los links.
const CASCARAS = /\/(compras|proveedores|precios)\/detalle\/?$/;

// https://astro.build/config
export default defineConfig({
  // Necesario para el canonical, el Open Graph y el sitemap.
  site: 'https://comprasestadouy.com',
  integrations: [sitemap({ filter: (page) => !CASCARAS.test(page) })],
  vite: {
    plugins: [tailwindcss()]
  }
});