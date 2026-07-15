import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}. Copiá .env.example a .env y completala.`);
    process.exit(1);
  }
  return value;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // Base del feed OCDS de ARCE
  ocdsBase: 'http://www.comprasestatales.gub.uy/ocds',

  // Cuántos releases pedir en paralelo (el feed es N+1: un GET por release).
  // Lo dejamos bajo para no golpear el servidor del Estado.
  fetchConcurrency: 6,

  // Tamaño de lote para los writes a Supabase.
  dbChunkSize: 500,
} as const;
