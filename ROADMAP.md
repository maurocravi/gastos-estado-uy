# Roadmap

Estado al 2026-07-15: pipeline OCDS→Supabase completo (ingest/repair/rates/
normalize + refresh de vistas materializadas), front Astro con cron diario que
ingiere, buildea y despliega solo. La base tiene 2025 completo + 2026 (enero a
julio parcial): 127.336 compras, 159.128 adjudicaciones, 386.216 ítems,
~$205 mil millones UYU adjudicados.

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

1. **Ingerir historia (más meses)** ✔ 2025 completo (2026-07-15)
   Hecho para 2025 y 2026. Extensión pendiente: 2024 hacia atrás, si el feed
   llega (~13k releases/mes). Procedimiento vigente: meses en cualquier orden
   y cerrar con `repair` + `rates` + `normalize` (que ya refresca las vistas
   materializadas) y el backfill SQL de `purchases` desde `releases.raw`
   (ver memoria del proyecto). Con 2025 las vistas dash_* pasaron a
   materializadas: más historia solo alarga el refresh, no el build.

   **Bloqueante: 2024 no entra en el free tier de Supabase.** Medido el
   2026-07-18: la base está en 423 de 500 MB y ya es casi todo dato
   normalizado, no raw archivable (award_items 134 MB, releases 111,
   dash_compras 66, awards 46, dash_adjudicaciones 29, purchases 19). Cada
   año adicional agrega ~200 MB (~125 de tablas + ~60 de matviews + ~20 de
   metadata de releases): 2024 nos deja en ~620 MB. Opciones evaluadas:
   - **Migrar a Postgres + PostgREST en un VPS propio** (recomendada si se
     ingiere más historia). Del stack de Supabase solo usamos esas dos
     piezas; PostgREST es un contenedor standalone y el JS del sitio
     funcionaría casi sin cambios (URL base nueva; el header apikey sobra
     pero no molesta). Gestionable con Dokploy: el panel es open source
     (gratis en el mismo VPS) o Dokploy Cloud a US$ 4,50/mes — en ambos
     casos el VPS va aparte (~US$ 4-6/mes). Elegir VPS con región São
     Paulo (DigitalOcean/Vultr; Hetzner no tiene Sudamérica) para no
     empeorar la latencia del buscador client-side vs sa-east-1 actual.
     Plan de migración: dump/restore, PostgREST con rol anon + grants +
     RLS + statement_timeout, secrets nuevos en el cron de GitHub Actions,
     backups automáticos, y `pruebas-sitio.py` contra el endpoint nuevo.
     Se pierde: dashboard de Supabase, MCP, y la pausa por inactividad
     (esto último es ganancia).
   - **Supabase Pro** (US$ 25/mes, 8 GB): cero migración, 4-5× el costo.

2. **Buscador con filtros** ✔ (2026-07-16)
   `/compras` es ahora un buscador client-side sobre `dash_compras` (misma
   arquitectura que el detalle: JS + PostgREST con la publishable key).
   Filtros: texto full-text en español sin tildes (config `es_unaccent`,
   recorre título + todos los ítems adjudicados), organismo, proveedor
   (autocomplete), tipo de procedimiento (cobertura ~32%, ARCE solo lo
   informa en los llamados), estado (grupos semánticos), rango de fechas de
   adjudicación y de montos; orden por monto o fecha, paginado de a 50 con
   total exacto, y filtros en el querystring (URLs compartibles). La vista
   ganó `fecha`, `tipo`, `supplier_ids` y el tsvector `busqueda` (+índices
   GIN); un número de compra pegado en el buscador va directo a esa compra.

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
   export CSV. Con 2025+2026 cargados ya hay dos años comparables.

6. **Flag de outliers de la fuente**
   Hay compras donde el organismo carga la "cantidad" como unidades
   presupuestales y el total explota. Casos confirmados (ambos UTE, los números
   coinciden con la ficha oficial de ARCE, no es bug del pipeline):
   - 1315467 "servicio de chofer": 27.000.000 × $454,29 ≈ $12,3 mil millones.
   - 1210976 subestaciones: 798.848 × $88.760,80 ≈ $71,0 mil millones (34% del
     total del sitio y top-1 del listado).

   También existe el caso inverso: montos simbólicos ridículamente chicos.
   Confirmado (2026-07-18): 1309282 OSE "operación de PTAR Pueblo Gil"
   figura como 1 unidad × $12 en SICE y en la ficha oficial de ARCE, pero el
   acta de resolución (PDF adjunto a la adjudicación) autoriza
   $U 5.614.008 + IVA. El pipeline es fiel a la fuente; quien cargó la
   adjudicación puso un precio testimonial. Idea: flag para adjudicaciones
   con total menor a un umbral (~$1.000) con aviso en el detalle
   ("monto posiblemente simbólico; ver el acta"), reutilizando la misma
   tabla `outliers` con motivo.

   Y fechas de adjudicación sucias: ~3.690 adjudicaciones (2,3%) son
   anteriores a 2025. Casi todas legítimas (procesos de 2023-24 publicados
   dentro de nuestra ventana de ingesta, regularizaciones 2019-22), pero la
   compra 1244146 (ANEP, excepción 38/2025) trae "Fecha Resolución:
   30/04/2005" también en la ficha oficial de ARCE: typo por 2025. Como
   dash_kpis.desde era min(award_date), la portada decía "adjudicaciones
   desde 30/04/2005"; se cambió el subtítulo para describir la cobertura de
   ingesta (2026-07-18). El typo en sí queda como candidato a `outliers`.
   Idea: lista curada de ocids (tabla `outliers` con motivo) + heurística que
   solo *sugiera* candidatos; las vistas dash_* excluyen lo flaggeado de las
   agregaciones y el front muestra la compra con un aviso, nunca la oculta.
   Ojo con falsos positivos: hay obras legítimas de miles de millones.
