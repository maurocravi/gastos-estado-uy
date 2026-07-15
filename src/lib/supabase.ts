import { createClient } from '@supabase/supabase-js';

// Cliente de SOLO LECTURA para el frontend / build. Usa la publishable key:
// solo ve lo que las policies RLS permiten (las tablas públicas y las vistas
// dash_*). La service_role queda exclusivamente en los scripts de ingesta.
const url = import.meta.env.SUPABASE_URL as string | undefined;
const key = import.meta.env.SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error(
    'Faltan SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY en .env (mirá .env.example).',
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

/** Tira si la consulta falló; devuelve los datos tipados. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }, ctx: string): T {
  if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${ctx}: sin datos`);
  return res.data;
}
