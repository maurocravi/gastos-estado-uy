# Roadmap

Estado al 2026-07-03: pipeline OCDS→Supabase completo (ingest/rates/normalize),
front Astro estático con resumen, organismos, proveedores, compras y detalle
por compra. La base tiene todo 2026 (enero a julio parcial): 41.863 compras,
48.851 adjudicaciones, 121.242 ítems. Todo se actualiza manualmente.

## Automatización (pendiente)

Hoy el flujo es manual en dos capas:

1. **Datos**: `npm run ingest -- <año> <mes>` → `npm run repair` → `npm run rates`
   → `npm run normalize`. El pipeline es idempotente: reprocesar el mes en curso
   actualiza sin duplicar, y `repair` reconstruye desde `releases.raw` cualquier
   award que haya quedado desviado (vista `awards_desactualizados`).
2. **Sitio**: es estático — los datos quedan congelados en el build. Después de
   actualizar datos hay que hacer `astro build` + deploy.

Plan propuesto:

- [x] Inicializar repo git y subir a GitHub (2026-07-14):
      https://github.com/maurocravi/gastos-estado-uy
- [x] Hosting estático (2026-07-14): Cloudflare Pages, deploy por CLI
      (`npx wrangler pages deploy dist --project-name gastos-estado-uy --branch main`).
      Sitio: https://gastos-estado-uy.pages.dev. Pages limita a 20.000 archivos
      por deploy → el detalle de compra dejó de ser estático (eran 42k páginas):
      ahora es una página única (`/compras/detalle`) que carga los datos por JS
      desde PostgREST con la publishable key; `public/_redirects` reescribe
      `/compras/{id}` hacia ella (rewrite 200, la URL no cambia). El build quedó
      en ~6.300 páginas / ~1m15s y escala a toda la historia.
- [x] GitHub Action con cron diario (2026-07-14): `.github/workflows/actualizar.yml`
      corre a las 08:00 UTC (05:00 UY): ingest del mes en curso (y el anterior
      los primeros 3 días del mes), repair + rates + normalize, build y deploy.
      Secrets del repo: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (datos),
      `SUPABASE_PUBLISHABLE_KEY` (build), `CLOUDFLARE_API_TOKEN` +
      `CLOUDFLARE_ACCOUNT_ID` (deploy). De paso mantiene activo el proyecto
      Supabase free (se pausa tras ~7 días sin actividad; pasó el 2026-07-14).
- [x] Alerta si el job falla: GitHub avisa por mail al dueño del repo cuando
      un workflow falla (comportamiento por defecto, sin configurar nada).
- [ ] Alerta si el job falla (el feed de ARCE a veces devuelve 404 en releases
      listados en su propio RSS; el ingest ya lo tolera).

## Funcionalidades (en orden de valor)

1. **Ingerir historia (más meses)** ✔ 2026 completo (2026-07-03)
   Hecho para enero–julio 2026. Extensión pendiente: 2025 hacia atrás (el feed
   lo tiene, ~13k releases/mes) con el mismo procedimiento:
   ingerir en orden cronológico viejo→nuevo y **re-ingerir los meses ya
   cargados al final** (el ingest borra/reinserta awards por ocid: un mes viejo
   pisaría ajustes de adjudicación más nuevos). Cerrar siempre con `rates`,
   `normalize` y el backfill SQL de `purchases` desde `releases.raw`
   (ver memoria del proyecto).

2. **Buscador con filtros**
   Hoy solo se ven las 100 compras más grandes; hay ~8.000 invisibles por mes.
   Sin abandonar el sitio estático: JS en el cliente consultando la API REST de
   Supabase con la publishable key (RLS de solo lectura ya configurado).
   Filtros: organismo, proveedor, texto, rango de montos/fechas.

3. **Fichas de organismo y proveedor** ✔ (2026-07-04)
   `/organismos/[id]` (282) y `/proveedores/[id]` (~5.900) con KPIs,
   contrapartes principales con % de concentración y compras mayores, todo
   linkeado desde listados y detalle de compra. Los datos salen de
   `dash_adjudicaciones` + `dash_compras` (ahora con `buyer_id`) cargadas una
   vez por build en `src/lib/entidades.ts`; los ids raros de proveedores
   extranjeros se sanean con `slugEntidad`.

4. **Comparador de precios unitarios**
   Los ítems traen clasificación, cantidad, unidad y monto normalizado a pesos:
   permite responder "¿cuánto pagó cada organismo por el mismo producto?".
   Alto valor de transparencia/periodístico con datos que ya tenemos.

5. **Evolución temporal, alertas y export**
   Series mensuales por organismo/rubro, alertas de adjudicaciones grandes,
   export CSV. Las dos primeras necesitan el punto 1.
