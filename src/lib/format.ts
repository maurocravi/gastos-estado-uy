// Formateo de números para es-UY: punto de miles, coma decimal.

const entero = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 });

/** 8135 -> "8.135" */
export function int(n: number | null | undefined): string {
  return n == null ? '—' : entero.format(n);
}

/** Monto en pesos: 1234567.8 -> "$ 1.234.568" */
export function uyu(n: number | null | undefined): string {
  return n == null ? '—' : `$ ${entero.format(Math.round(n))}`;
}

/** Monto compacto para KPIs y barras: 19633091739 -> "$ 19.633 M" */
export function uyuM(n: number | null | undefined, prefix = '$'): string {
  if (n == null) return '—';
  const millones = n / 1e6;
  const dec = millones >= 100 ? 0 : 1;
  return `${prefix} ${new Intl.NumberFormat('es-UY', {
    maximumFractionDigits: dec,
    minimumFractionDigits: 0,
  }).format(millones)} M`;
}

const decimales = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 });

/** Monto en su moneda original: (1234.5, "USD") -> "USD 1.234,5" */
export function moneda(n: number | null | undefined, curr: string | null | undefined): string {
  if (n == null) return '—';
  return `${curr ?? ''} ${decimales.format(n)}`.trim();
}

/** Cantidad con hasta 2 decimales: 2.5 -> "2,5" */
export function cant(n: number | null | undefined): string {
  return n == null ? '—' : decimales.format(n);
}

/** Fracción como porcentaje: (0.8135) -> "81,4 %" */
export function pct(fraccion: number | null | undefined): string {
  if (fraccion == null || !isFinite(fraccion)) return '—';
  return `${(fraccion * 100).toFixed(1).replace('.', ',')} %`;
}

/** "2026-05-31" -> "31/05/2026" (sin sorpresas de timezone). */
export function fecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Título con fallback y largo acotado para celdas de tabla. */
export function titulo(t: string | null | undefined, max = 90): string {
  if (!t) return 'Sin título';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
