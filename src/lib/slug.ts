// Módulo propio (sin dependencias) porque lo importa también el script de
// cliente del detalle de compra: no puede arrastrar el cliente de Supabase.

/**
 * id de entidad → segmento de URL. Los ids locales (RUT / "n-n") ya son
 * URL-safe; los proveedores extranjeros traen espacios, barras o ":" (21
 * casos) y se colapsan a "~". La unicidad se verifica en cargarEntidades.
 */
export function slugEntidad(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, '~');
}
