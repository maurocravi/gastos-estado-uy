// Detalle de compra servido ya armado: /compras/{id}.
// La mecánica (cáscara + HTMLRewriter + caché + 404) está en _lib/servir-ficha.ts.

import { servirFicha } from '../_lib/servir-ficha';
import { cargarCompra, idValido } from '../../src/lib/ficha-compra';

export const onRequest = servirFicha({
  cascara: '/compras/detalle/',
  contenedor: 'detalle',
  validar: idValido,
  path: (id) => `/compras/${id}`,
  cargar: cargarCompra,
});
