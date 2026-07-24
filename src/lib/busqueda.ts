// Última búsqueda de un buscador (query string, sin el "?"). El buscador la
// guarda en cada búsqueda y el detalle usa la vuelta para que el «←» restaure
// los mismos filtros. sessionStorage: dura lo que la pestaña; si no hay nada
// guardado (llegada directa al detalle) se vuelve al listado pelado.

function guardar(clave: string, qs: string): void {
  try {
    sessionStorage.setItem(clave, qs);
  } catch {
    /* sessionStorage puede fallar (modo privado); el link queda pelado */
  }
}

function urlVolver(clave: string, base: string): string {
  try {
    const qs = sessionStorage.getItem(clave);
    return qs ? `${base}?${qs}` : base;
  } catch {
    return base;
  }
}

// ── /compras ────────────────────────────────────────────────────────────
export const guardarBusquedaCompras = (qs: string) => guardar('compras:ultima-busqueda', qs);
export const urlVolverCompras = () => urlVolver('compras:ultima-busqueda', '/compras');

// ── /precios ────────────────────────────────────────────────────────────
export const guardarBusquedaPrecios = (qs: string) => guardar('precios:ultima-busqueda', qs);
export const urlVolverPrecios = () => urlVolver('precios:ultima-busqueda', '/precios');
