// Piezas de HTML comunes a las fichas que se arman como string (compra y
// proveedor), tanto en la Pages Function como en el cliente. Sin
// dependencias: corre en el navegador y en Workers.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Lo que la Pages Function inyecta en la cáscara. */
export interface FichaArmada {
  /** <title> completo. */
  titulo: string;
  /** <meta name="description"> y Open Graph. */
  descripcion: string;
  /** Contenido del contenedor de la ficha. */
  html: string;
}

export const kpi = (label: string, value: string, sub: string) => `
  <div class="rounded-lg border border-line bg-surface px-6 py-5 col-span-12 sm:col-span-4">
    <p class="text-xs font-medium tracking-wide text-ink-soft uppercase">${esc(label)}</p>
    <p class="num mt-2 text-2xl font-medium text-ink">${esc(value)}</p>
    <p class="mt-1 text-xs text-ink-faint">${esc(sub)}</p>
  </div>`;

export const card = (title: string, sub: string | null, cuerpo: string) => `
  <section class="rounded-lg border border-line bg-surface p-6 col-span-12">
    <header class="mb-5">
      <h2 class="text-sm font-semibold text-ink">${esc(title)}</h2>
      ${sub ? `<p class="mt-0.5 text-xs text-ink-faint">${esc(sub)}</p>` : ''}
    </header>
    ${cuerpo}
  </section>`;

/** Contenido de la ficha para un estado sin datos (cargando, error, no encontrado). */
export function mensajeHtml(volver: string, texto: string): string {
  return `
  <div class="col-span-12">
    ${volver}
    <p class="mt-2 text-sm text-ink-soft">${esc(texto)}</p>
  </div>`;
}

/** Recorta a ~160 caracteres (lo que Google muestra del snippet) sin cortar palabras. */
export function recortarDescripcion(s: string, max = 160): string {
  const limpio = s.replace(/\s+/g, ' ').trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max - 1);
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > max * 0.6 ? corte.slice(0, espacio) : corte).replace(/[\s.,;:]+$/, '')}…`;
}
