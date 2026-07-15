# compras-estado-uy · ingesta OCDS

Script de ingesta de datos de compras del Estado uruguayo (formato OCDS de ARCE)
hacia Supabase. Es el **paso 1** del proyecto: la rebanada vertical fina que trae
un mes de datos y lo deja en las tablas `entities`, `purchases`, `awards` y
`award_items` (más el log crudo en `releases`).

## Setup

```bash
npm install
cp .env.example .env   # y completá SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
```

La `SUPABASE_SERVICE_ROLE_KEY` está en Project Settings → API. Es secreta: la
ingesta la usa para saltear RLS al escribir. Nunca va al frontend ni al repo.

## Uso

```bash
# Mes anterior completo
npm run ingest

# Un mes puntual
npm run ingest -- 2026-06

# Prueba rápida: solo los primeros 50 releases del mes
npm run ingest -- 2026-06 --limit 50
```

Arrancá siempre con `--limit 50` la primera vez para verificar que entra bien
antes de largar el mes completo (que puede ser miles de releases).

## Cómo funciona

1. Pide la lista de releases del mes al feed RSS: `/ocds/rss/AAAA/MM`.
2. Trae cada release individual (`/ocds/release/{id}`) con concurrencia acotada.
3. Los transforma y acumula en memoria (deduplicando adjudicaciones; el último
   release de cada una gana, así maneja los `awardUpdate`).
4. Escribe a Supabase respetando el orden de las FKs. Es **re-ejecutable**:
   borra las adjudicaciones de los ocids de la corrida y las reinserta.

Los montos se guardan en su moneda original (`amount` + `currency`).
Las columnas `amount_uyu` / `amount_usd` quedan en `null`: se completan en el
**paso 3** (normalización con cotizaciones del BCU).

## Cotizaciones del BCU (paso 2)

Trae las cotizaciones oficiales del BCU y las guarda en `currency_rates`, para
poder normalizar montos a pesos en el paso 3.

```bash
npm run rates
```

Es data-driven: mira el rango de fechas de las adjudicaciones que hay en la base
(con 7 días de buffer hacia atrás, para cubrir feriados y fines de semana) y
consulta el web service SOAP del BCU en ventanas de 31 días (su tope).

Monedas mapeadas: USD (2225), EUR (1111), UYI/Unidad Indexada (9800). UYU es la
base (rate 1) y no se consulta. Si en tus datos aparece UR (Unidad Reajustable)
u otra moneda, agregala en el mapa `CURRENCIES` de `src/rates.ts`.

Se guarda el promedio comprador/vendedor como `rate_uyu`. Para dólar se usa la
cotización billete (2225); si preferís la de valuación contable, cambiá el código
a 2230 (promedio fondo).

> Nota: el servidor del BCU a veces tiene una cadena TLS quisquillosa. Si el
> fetch falla por certificado, podés correr con
> `NODE_TLS_REJECT_UNAUTHORIZED=0 npm run rates` (solo para este servicio del
> Estado; no es lo ideal como práctica general).

## Normalización de montos (paso 3)

Completa `award_items.amount_uyu` / `amount_usd` a partir de `amount` + `currency`
y las cotizaciones de `currency_rates`.

```bash
npm run normalize            # solo items pendientes (amount_uyu is null)
npm run normalize -- --force # recalcula todos (ej: tras recargar rates)
```

Para cada item usa la cotización del día de su adjudicación, o la **anterior más
cercana** si ese día no cotiza (fin de semana / feriado) — de ahí el buffer del
paso 2. La fórmula es `amount_uyu = amount * rate(currency, fecha)` (UYU = 1) y
`amount_usd = amount_uyu / rate('USD', fecha)`. Si una moneda no tiene cotización
disponible, el item se deja en `null` y se reporta al final.

## Type-check

```bash
npm run typecheck
```
