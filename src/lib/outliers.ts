// Flags de datos no representativos EN LA FUENTE (tabla `outliers`, curada a
// mano). No son bugs del pipeline: coinciden con la ficha oficial de ARCE.
// Solo 'monto_inflado' se excluye de totales y rankings (las vistas dash_*
// ponen su total en NULL); los demás tipos solo muestran un aviso. La compra
// nunca se oculta. Ver ROADMAP punto 6.

export type TipoOutlier = 'monto_inflado' | 'monto_simbolico' | 'fecha';

/** Etiqueta corta para el badge en tablas y listados. */
export function etiquetaOutlier(tipo: string | null | undefined): string | null {
  switch (tipo) {
    case 'monto_inflado':
      return 'monto no representativo';
    case 'monto_simbolico':
      return 'monto simbólico';
    case 'fecha':
      return 'fecha con error de la fuente';
    default:
      return null;
  }
}

/** Texto del aviso en el detalle si no hay `nota` curada (fallback). */
export function avisoOutlier(tipo: string | null | undefined): string | null {
  switch (tipo) {
    case 'monto_inflado':
      return 'El monto de esta compra no es representativo (la fuente cargó una cantidad como unidades presupuestales). Se muestra fiel a ARCE, pero queda excluida de los totales y rankings del sitio.';
    case 'monto_simbolico':
      return 'El monto adjudicado parece simbólico o testimonial: revisá el acta de adjudicación para el importe real.';
    case 'fecha':
      return 'La fecha de adjudicación tiene un error de tipeo en la fuente.';
    default:
      return null;
  }
}
