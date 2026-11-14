// Ficha de proveedor servida ya armada: /proveedores/{slug}.
// La mecánica (cáscara + HTMLRewriter + caché + 404) está en _lib/servir-ficha.ts.

import { servirFicha } from '../_lib/servir-ficha';
import { cargarFicha, slugValido } from '../../src/lib/ficha-proveedor';

export const onRequest = servirFicha({
  cascara: '/proveedores/detalle/',
  contenedor: 'ficha',
  validar: slugValido,
  path: (slug) => `/proveedores/${encodeURIComponent(slug)}`,
  cargar: cargarFicha,
});
