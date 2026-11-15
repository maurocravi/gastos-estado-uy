# Compras Estado UY

Portal de transparencia sobre las compras públicas del Estado uruguayo:
**https://comprasestadouy.com**

Toma los datos abiertos que publica ARCE (Agencia Reguladora de Compras
Estatales) en formato [OCDS](https://standard.open-contracting.org/), los
normaliza a pesos con las cotizaciones del BCU y los muestra de forma
navegable: qué se compró, quién lo compró, a quién y a qué precio.

Cobertura: 2025 completo y 2026 hasta el mes en curso (actualización diaria).
Los años anteriores solo aparecen como fragmentos (ajustes de adjudicaciones
viejas publicados en releases nuevos).

## Qué hay en el sitio

| Ruta | Contenido |
| :--- | :-------- |
| `/` | Portada con KPIs y rankings de gasto. |
| `/compras` | Buscador de compras (texto full-text, organismo, proveedor, tipo, estado, fechas, montos). Los filtros viajan en la URL. |
| `/compras/{id}` | Detalle de una compra: llamado, adjudicaciones e ítems. |
| `/organismos`, `/organismos/{id}` | Listado y ficha de cada organismo comprador. |
| `/proveedores`, `/proveedores/{slug}` | Listado y ficha de cada proveedor. |
| `/precios`, `/precios/{id}` | Comparador de precios unitarios por producto y unidad (mediana y rango p25–p75, por organismo y por proveedor). |
| `/acerca` | Qué es el sitio, de dónde salen los datos y sus limitaciones. |

Los datos de la fuente con errores evidentes (montos inflados, montos
simbólicos, fechas con typo) están en la tabla curada `outliers`: se muestran
con aviso en el registro individual y se excluyen de los totales y rankings,
declarándolo (`src/lib/outliers.ts`).

## Arquitectura

```
ARCE (feed OCDS + fichas web)   BCU (cotizaciones)
            │                         │
            └── scripts de ingesta ───┘      src/scripts/ (service_role key)
                         │
                   Supabase (Postgres)        tablas + vistas materializadas dash_*
                         │
         ┌───────────────┼──────────────────┐
     astro build    JS del navegador    Pages Functions     (publishable key, solo lectura vía RLS)
   (páginas estáticas)  (buscadores,     (fichas armadas
                        /precios/{id})    en el servidor)
         └───────────────┴──────────────────┘
                 Cloudflare Pages
```

- **Datos**: Supabase (plan free). Las tablas base son `entities`,
  `purchases`, `awards`, `award_items`, `releases` y `currency_rates`. Lo que
  consume el sitio sale de las vistas materializadas `dash_*`.
- **Sitio**: [Astro](https://astro.build) + Tailwind, salida estática.
  Portada, listados y fichas de organismo se generan en el build.
- **Páginas con muchas URLs**: Cloudflare Pages permite como máximo 20.000
  archivos por deploy, así que el detalle de compra (unas 130 mil), la ficha
  de proveedor y el detalle de precios se generan una sola vez como
  "cáscara" (`src/pages/*/detalle.astro`) y `public/_redirects` reescribe
  `/compras/{id}`, `/proveedores/{slug}` y `/precios/{id}` hacia ella.
- **Pages Functions** (`functions/`): `/compras/{id}` y `/proveedores/{slug}`
  los atiende primero una Function que toma la cáscara del build, le inyecta
  el contenido, el título, la descripción, el Open Graph y el canonical, y
  devuelve 404 real si el id no existe. Es para que Google indexe las fichas.
  Cachea 6 horas en el edge. Si Supabase falla, devuelve la cáscara y el
  navegador carga los datos. La lógica común está en
  `functions/_lib/servir-ficha.ts`.
- **SEO**: canonical, Open Graph y structured data en `Layout.astro`;
  sitemap con `@astrojs/sitemap` más uno propio para las fichas de proveedor
  (`src/pages/sitemap-proveedores.xml.ts`). Las cáscaras quedan fuera del
  sitemap.

## Puesta en marcha

Requiere Node 22.12 o superior.

```bash
npm install
cp .env.example .env
```

Variables de `.env`:

| Variable | Para qué | Dónde se usa |
| :------- | :------- | :----------- |
| `SUPABASE_URL` | URL del proyecto Supabase | todo |
| `SUPABASE_SERVICE_ROLE_KEY` | Escritura, saltea RLS. **Secreta**: nunca va al frontend ni al repo | scripts de ingesta |
| `SUPABASE_PUBLISHABLE_KEY` | Lectura pública vía RLS | build y navegador |

```bash
astro dev --background   # dev server en localhost:4321 (astro dev stop / status / logs)
npm run build            # sitio estático en dist/
npm run typecheck
```

En el dev server, `src/middleware.ts` replica los rewrites de `_redirects`.
Las Pages Functions no corren con `astro dev`: para probarlas, buildeá y usá
`npx wrangler pages dev dist`.

## Pipeline de datos

Todos los pasos son idempotentes: reprocesar un mes actualiza sin duplicar.

```bash
npm run ingest -- 2026-11            # releases OCDS de un mes (--limit 50 para probar)
npm run scrape -- --limit 3000       # título, descripción y tipo desde la ficha web de ARCE
npm run repair                       # reconstruye awards desviados desde releases.raw
npm run rates                        # cotizaciones del BCU
npm run normalize                    # montos a UYU/USD y refresco de las vistas dash_*
```

Otros scripts:

- `npm run backfill-purchases`: recalcula título y descripción de las compras
  desde `archivo/` y `releases.raw` (tras ingerir historia).
- `npm run archivar`: mueve `releases.raw` de meses cerrados a
  `archivo/releases-AAAA-MM.ndjson.gz` para liberar espacio en la base.

El detalle de cada paso está en [src/scripts/README.md](src/scripts/README.md).

## Actualización automática

[`.github/workflows/actualizar.yml`](.github/workflows/actualizar.yml) corre
todos los días a las 08:00 UTC (05:00 en Uruguay): ingiere el mes en curso (y
el anterior los primeros 3 días del mes), scrape, repair, rates, normalize,
build y deploy a Cloudflare Pages con wrangler. También mantiene activo el
proyecto Supabase free y se re-habilita a sí mismo para que GitHub no apague
el cron tras 60 días sin commits. Si falla, GitHub avisa por mail.

Secrets del repo: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Deploy manual:

```bash
npm run build
npx wrangler pages deploy dist --project-name gastos-estado-uy --branch main
```

## Pruebas

```bash
python3 src/scripts/pruebas-sitio.py
```

Compara lo que muestra el sitio en producción (páginas estáticas por HTTP y
client-side con Chrome headless) contra recálculos independientes desde las
tablas base. Conviene correrlo después de cada ingesta o deploy. Con
`SITIO=http://localhost:4321` prueba un cambio antes de desplegarlo. Requiere
Google Chrome instalado.

## Estructura

```
src/
  pages/        rutas del sitio (y las cáscaras */detalle.astro)
  components/   componentes Astro
  layouts/      Layout.astro (head, SEO, nav, pie)
  lib/          acceso a datos, armado de fichas, formato, outliers
  scripts/      pipeline de ingesta y pruebas
functions/      Pages Functions (fichas armadas en el servidor)
public/         estáticos, _redirects, robots.txt, og.png
archivo/        releases crudos archivados por mes (.ndjson.gz)
```

## Limitaciones conocidas

- La base está al borde del límite de 500 MB del plan free de Supabase (479
  MB al 2026-11-15). Seguir creciendo, e ingerir 2024 hacia atrás, requiere
  migrar la base fuera del plan free.
- Después de `npm run archivar` hay que correr
  `VACUUM FULL ANALYZE public.releases` en la base: sin eso el espacio no se
  libera.
- El feed OCDS solo trae título y descripción en los releases de llamado (un
  tercio de las compras); el resto se completa con el scrape de las fichas
  web de ARCE.
- Los montos son los que publica la fuente. Los errores detectados están
  marcados, no corregidos.
