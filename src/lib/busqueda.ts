// Última búsqueda de /compras (query string, sin el "?"). El buscador la
// guarda en cada búsqueda y el detalle de compra la usa para que «← Compras»
// vuelva a los mismos filtros. sessionStorage: dura lo que la pestaña; si no
// hay nada guardado (llegada directa al detalle) se vuelve al listado pelado.
const CLAVE = 'compras:ultima-busqueda';

export function guardarBusquedaCompras(qs: string): void {
  try {
    sessionStorage.setItem(CLAVE, qs);
  } catch {
    /* sessionStorage puede fallar (modo privado); el link queda pelado */
  }
}

export function urlVolverCompras(): string {
  try {
    const qs = sessionStorage.getItem(CLAVE);
    return qs ? `/compras?${qs}` : '/compras';
  } catch {
    return '/compras';
  }
}
