#!/usr/bin/env python3
"""Pruebas de consistencia del sitio en producción contra la base (PostgREST).

Compara lo que muestran las páginas (estáticas via HTTP, client-side via
Chrome headless — incluye el buscador de /compras) con recálculos
independientes desde las tablas base.

Uso: python3 src/scripts/pruebas-sitio.py  (requiere Chrome instalado; usa la
publishable key de .env, la misma del navegador). Pensado para correrse tras
cada ingesta/deploy: todos los casos se derivan de los datos vigentes salvo
tres compras fijas de 2026 (1074933, 1347791, 1023673).
"""

import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

SITIO = "https://gastos-estado-uy.pages.dev"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# --- credenciales desde .env -------------------------------------------------
import os
ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
env = {}
for linea in open(ENV):
    if "=" in linea and not linea.strip().startswith("#"):
        k, v = linea.split("=", 1)
        env[k.strip()] = v.strip().strip("'\"")
URL, KEY = env["SUPABASE_URL"], env["SUPABASE_PUBLISHABLE_KEY"]

resultados = []


def check(nombre, ok, detalle=""):
    resultados.append((nombre, ok, detalle))
    print(f"{'PASS' if ok else 'FAIL'}  {nombre}" + (f"  [{detalle}]" if detalle else ""))


# --- helpers -----------------------------------------------------------------
def db(recurso, intentos=3, count=False, **params):
    """GET a PostgREST con la key pública (la misma que usa el navegador)."""
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{URL}/rest/v1/{recurso}?{qs}", headers={"apikey": KEY})
    if count:
        req.add_header("Prefer", "count=exact")
        req.add_header("Range", "0-0")
        req.add_header("Range-Unit", "items")
    for i in range(intentos):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                datos = json.load(r)
                if count:
                    return int(r.headers["Content-Range"].split("/")[1])
                return datos
        except Exception as e:
            if i == intentos - 1:
                raise
            time.sleep(2 * (i + 1))


def db_todo(recurso, **params):
    """Pagina de a 1000 (tope top-level de PostgREST)."""
    filas = []
    for desde in range(0, 10**6, 1000):
        pagina = db(recurso, limit=1000, offset=desde, **params)
        filas.extend(pagina)
        if len(pagina) < 1000:
            return filas


def pagina_http(path):
    req = urllib.request.Request(SITIO + path, headers={"User-Agent": "pruebas-sitio"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def render(path):
    """HTML post-JS de una página client-side, via Chrome headless."""
    out = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
         "--virtual-time-budget=20000", "--dump-dom", SITIO + path],
        capture_output=True, text=True, timeout=120,
    )
    return out.stdout


def texto(html):
    t = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t)


def num_es(s):
    """'5.682.551.604' -> 5682551604"""
    return int(s.replace(".", ""))


# ==============================================================================
# 1. Buscador /compras/ (client-side): orden, duplicados, totales y full-text
# ==============================================================================
html = render("/compras/")
trs = re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S)
listado = []
for tr in trs:
    m_id = re.search(r'href="/compras/(\d+)"', tr)
    m_tot = re.findall(r">\$ ([\d.]+)<", tr)
    if m_id and m_tot:
        listado.append((int(m_id.group(1)), num_es(m_tot[-1])))

check("buscador: 50 filas (una página)", len(listado) == 50, f"{len(listado)} filas")
ids = [i for i, _ in listado]
check("buscador: sin compras repetidas", len(set(ids)) == len(ids))
tots = [t for _, t in listado]
check("buscador: ordenado por monto desc", tots == sorted(tots, reverse=True))

# totales de una muestra contra dash_compras (fila por fila, sin sort pesado)
muestra = [listado[0], listado[9], listado[49]]
difs = []
for id_compra, total_pagina in muestra:
    fila = db("dash_compras", select="total_uyu,adjudicaciones", id_compra=f"eq.{id_compra}")[0]
    difs.append(abs(round(fila["total_uyu"]) - total_pagina))
check("buscador: totales coinciden con dash_compras (muestra de 3)", max(difs) <= 1, f"difs {difs}")

# el contador sin filtros == count(dash_compras)
m_total = re.search(r"([\d.]+) compras encontradas", texto(html))
n_total_base = db("dash_compras", count=True, select="ocid")
check(
    "buscador: contador sin filtros == count(dash_compras)",
    m_total is not None and num_es(m_total.group(1)) == n_total_base,
    f"pagina={m_total.group(1) if m_total else None} base={n_total_base}",
)

# full-text: mismo total en la página (con tilde) que en la base (sin tilde)
t_fts = texto(render("/compras/?q=cami%C3%B3n"))
m_fts = re.search(r"([\d.]+) compras encontradas", t_fts)
n_fts_base = db("dash_compras", count=True, select="ocid", busqueda="wfts(es_unaccent).camion")
check(
    "buscador: total full-text 'camión' (página) == 'camion' (base)",
    m_fts is not None and num_es(m_fts.group(1)) == n_fts_base,
    f"pagina={m_fts.group(1) if m_fts else None} base={n_fts_base}",
)

# filtro por proveedor vía URL == count por supplier_ids
prov_filtro = "R210001230018"
t_prov = texto(render(f"/compras/?prov={prov_filtro}"))
m_prov = re.search(r"([\d.]+) compras encontradas", t_prov)
n_prov_base = db("dash_compras", count=True, select="ocid", supplier_ids=f'cs.{{"{prov_filtro}"}}')
check(
    "buscador: filtro proveedor (página) == count supplier_ids (base)",
    m_prov is not None and num_es(m_prov.group(1)) == n_prov_base,
    f"pagina={m_prov.group(1) if m_prov else None} base={n_prov_base}",
)

TOP_ID = listado[0][0]
TOP_TOTAL = listado[0][1]

# ==============================================================================
# 2. Detalle de compra: recálculo independiente desde award_items
# ==============================================================================
def detalle_esperado(id_compra):
    compra = db(
        "purchases",
        select="ocid,tender_title,awards(award_id,award_items(quantity,amount_uyu,currency))",
        id_compra=f"eq.{id_compra}",
    )[0]
    total = n_items = 0
    monedas = set()
    for a in compra["awards"]:
        for it in a["award_items"]:
            n_items += 1
            monedas.add(it["currency"])
            if it["amount_uyu"] is not None:
                total += it["amount_uyu"] * (it["quantity"] if it["quantity"] is not None else 1)
    return {"total": round(total), "awards": len(compra["awards"]), "items": n_items, "monedas": monedas}


def detalle_mostrado(id_compra):
    t = texto(render(f"/compras/{id_compra}"))
    m_tot = re.search(r"ADJUDICADO \$ ([\d.]+) pesos", t, re.I)
    m_adj = re.search(r"ADJUDICACIONES ([\d.]+) ([\d.]+) ítems", t, re.I)
    return t, (num_es(m_tot.group(1)) if m_tot else None), (
        (num_es(m_adj.group(1)), num_es(m_adj.group(2))) if m_adj else (None, None)
    )


for id_compra, etiqueta in [(TOP_ID, "top del listado"), (1074933, "55 adjudicaciones"), (1347791, "items en USD")]:
    esp = detalle_esperado(id_compra)
    t, total, (n_adj, n_items) = detalle_mostrado(id_compra)
    ok = (
        total is not None
        and abs(total - esp["total"]) <= 1
        and n_adj == esp["awards"]
        and n_items == esp["items"]
    )
    check(
        f"detalle {id_compra} ({etiqueta}): total/awards/items vs recálculo",
        ok,
        f"pagina=({total}, {n_adj} adj, {n_items} items) esperado=({esp['total']}, {esp['awards']} adj, {esp['items']} items)",
    )
    if id_compra == TOP_ID:
        check("detalle top == total del listado", total == TOP_TOTAL, f"{total} vs {TOP_TOTAL}")
    if id_compra == 1347791:
        check("detalle 1347791: muestra moneda original USD", "USD" in t)

# sin adjudicaciones
t, total, _ = detalle_mostrado(1023673)
check(
    "detalle 1023673 (sin adjudicaciones): mensaje correcto",
    "todavía no tiene adjudicaciones" in t and (total == 0 or "ADJUDICADO —" in t.upper() or "$ —" in t),
    t[t.find("ADJUDICADO") : t.find("ADJUDICADO") + 60] if "ADJUDICADO" in t else t[:100],
)

# compra inexistente e id inválido
t = texto(render("/compras/99999999"))
check("detalle inexistente: mensaje 'no encontramos'", "No encontramos la compra" in t)

# ==============================================================================
# 3. Consistencia global de vistas (dash_kpis vs conteos y sumas reales)
# ==============================================================================
kpis = db("dash_kpis", select="*")[0]
n_compras = db("dash_compras", count=True, select="ocid")
n_adj = db("dash_adjudicaciones", count=True, select="award_pk")
n_buyers = db("entities", count=True, select="id", is_buyer="eq.true")
n_suppliers = db("entities", count=True, select="id", is_supplier="eq.true")

check("kpis.compras == count(dash_compras)", kpis["compras"] == n_compras, f"{kpis['compras']} vs {n_compras}")
check("kpis.adjudicaciones == count(dash_adjudicaciones)", kpis["adjudicaciones"] == n_adj, f"{kpis['adjudicaciones']} vs {n_adj}")
check("kpis.organismos == count(is_buyer)", kpis["organismos"] == n_buyers, f"{kpis['organismos']} vs {n_buyers}")
check("kpis.proveedores == count(is_supplier)", kpis["proveedores"] == n_suppliers, f"{kpis['proveedores']} vs {n_suppliers}")

gasto_org = db_todo("dash_gasto_organismo", select="id,total_uyu,compras")
gasto_prov = db_todo("dash_gasto_proveedor", select="id,total_uyu,adjudicaciones")
suma_org = sum(r["total_uyu"] or 0 for r in gasto_org)
suma_prov = sum(r["total_uyu"] or 0 for r in gasto_prov)
tot = kpis["total_uyu"]
check(
    "total kpis ~ suma por organismo",
    abs(suma_org - tot) / tot < 0.005,
    f"kpis {tot:,.0f} vs org {suma_org:,.0f} (dif {100*abs(suma_org-tot)/tot:.3f}%)",
)
check(
    "total kpis ~ suma por proveedor",
    abs(suma_prov - tot) / tot < 0.005,
    f"kpis {tot:,.0f} vs prov {suma_prov:,.0f} (dif {100*abs(suma_prov-tot)/tot:.3f}%)",
)
# Las vistas de gasto solo cuentan compras/awards con >=1 ítem con amount_uyu
# (semántica deliberada del WHERE de la vista): la diferencia con los KPIs
# debe ser exactamente las compras sin adjudicación + las de total null.
sin_buyer = db("dash_compras", count=True, select="ocid", buyer_id="is.null")
sin_adj = db("dash_compras", count=True, select="ocid", adjudicaciones="eq.0")
solo_null = db("dash_compras", count=True, select="ocid", adjudicaciones="gt.0", total_uyu="is.null")
suma_compras_org = sum(r["compras"] for r in gasto_org)
check(
    "compras: suma por organismo + sin adj + total null + sin buyer == kpis",
    suma_compras_org + sin_adj + solo_null + sin_buyer == kpis["compras"],
    f"{suma_compras_org} + {sin_adj} + {solo_null} + {sin_buyer} vs {kpis['compras']}",
)
adj_total_null = db("dash_adjudicaciones", count=True, select="award_pk", total_uyu="is.null")
adj_sin_supplier = db("dash_adjudicaciones", count=True, select="award_pk", supplier_id="is.null")
suma_adj_prov = sum(r["adjudicaciones"] for r in gasto_prov)
check(
    "adjudicaciones: suma por proveedor + total null + sin supplier == kpis",
    suma_adj_prov + adj_total_null + adj_sin_supplier == kpis["adjudicaciones"],
    f"{suma_adj_prov} + {adj_total_null} + {adj_sin_supplier} vs {kpis['adjudicaciones']}",
)

# ==============================================================================
# 4. Resumen (index): KPIs mostrados vs dash_kpis
# ==============================================================================
t = texto(pagina_http("/"))
m = re.search(r"COMPRAS ([\d.]+) ([\d.]+) adjudicaciones", t, re.I)
m2 = re.search(r"ACTORES ([\d.]+) organismos compradores · ([\d.]+) proveedores", t, re.I)
ok = (
    m and m2
    and num_es(m.group(1)) == kpis["compras"]
    and num_es(m.group(2)) == kpis["adjudicaciones"]
    and num_es(m2.group(1)) == kpis["organismos"]
    and num_es(m2.group(2)) == kpis["proveedores"]
)
check(
    "resumen: KPIs de la portada == dash_kpis",
    bool(ok),
    f"portada=({m.groups() if m else None}, {m2.groups() if m2 else None}) kpis=({kpis['compras']}, {kpis['adjudicaciones']}, {kpis['organismos']}, {kpis['proveedores']})",
)

# ==============================================================================
# 5. Ficha de organismo (estática) vs recálculo desde dash_adjudicaciones
# ==============================================================================
top_org = max(gasto_org, key=lambda r: r["total_uyu"] or 0)
adj_org = db_todo(
    "dash_adjudicaciones",
    select="total_uyu,supplier_id",
    buyer_id=f"eq.{top_org['id']}",
    order="award_pk",
)
t = texto(pagina_http(f"/organismos/{top_org['id']}/"))
m_kpi = re.search(r"COMPRAS ([\d.]+) ([\d.]+) adjudicaciones", t, re.I)
n_compras_pagina = num_es(m_kpi.group(1)) if m_kpi else None
n_adj_pagina = num_es(m_kpi.group(2)) if m_kpi else None
check(
    f"organismo {top_org['id']} (el de mayor gasto): nº adjudicaciones ficha vs base",
    n_adj_pagina == len(adj_org),
    f"ficha={n_adj_pagina} base={len(adj_org)}",
)
n_compras_org = db("dash_compras", count=True, select="ocid", buyer_id=f"eq.{top_org['id']}")
check(
    f"organismo {top_org['id']}: nº compras ficha vs dash_compras",
    n_compras_pagina == n_compras_org,
    f"ficha={n_compras_pagina} base={n_compras_org}",
)
# el total en la ficha está en formato uyuM ("$ N.NNN M"): comparar con tolerancia
m_tot = re.search(r"ADJUDICADO \$ ([\d.,]+) M pesos", t, re.I)
total_base = sum(r["total_uyu"] or 0 for r in adj_org)
if m_tot:
    mostrado = float(m_tot.group(1).replace(".", "").replace(",", ".")) * 1e6
    check(
        f"organismo {top_org['id']}: total ficha ~ suma base",
        abs(mostrado - total_base) <= max(0.51e6, total_base * 0.001),
        f"ficha {mostrado:,.0f} vs base {total_base:,.0f}",
    )
else:
    check(f"organismo {top_org['id']}: total ficha ~ suma base", False, "no pude extraer el KPI")

# ==============================================================================
# 6. Ficha de proveedor (client-side) vs vistas; discrepancia 521 vs 517
# ==============================================================================
mega = "R210231300018"
fila_gasto = next(r for r in gasto_prov if r["id"] == mega)
n_dash_adj = db("dash_adjudicaciones", count=True, select="award_pk", supplier_id=f"eq.{mega}")
n_awards = db("awards", count=True, select="id", supplier_id=f"eq.{mega}")
n_null = db("dash_adjudicaciones", count=True, select="award_pk", supplier_id=f"eq.{mega}", total_uyu="is.null")
check(
    "MEGALABS: dash_adjudicaciones == awards (tabla base)",
    n_dash_adj == n_awards,
    f"dash={n_dash_adj} awards={n_awards}",
)
check(
    "MEGALABS: dash_gasto_proveedor == awards con monto normalizable",
    fila_gasto["adjudicaciones"] == n_awards - n_null,
    f"vista={fila_gasto['adjudicaciones']} awards={n_awards} de los cuales {n_null} sin monto",
)
t = texto(render(f"/proveedores/{mega}"))
m_adj = re.search(r"ADJUDICACIONES ([\d.]+) en ([\d.]+) compras", t, re.I)
check(
    "MEGALABS: ficha muestra el nº de la base",
    m_adj and num_es(m_adj.group(1)) == n_awards,
    f"ficha={m_adj.group(1) if m_adj else None} base={n_awards}",
)

# listado /proveedores/: el primero de la página es el de mayor gasto en la vista
top_prov = max(gasto_prov, key=lambda r: r["total_uyu"] or 0)
nombre_top = db("entities", select="name", id=f"eq.{top_prov['id']}")[0]["name"]
t_listado = texto(pagina_http("/proveedores/"))
m_primero = re.search(r"por monto adjudicado.*?1 (.*?) \$", t_listado)
check(
    "listado proveedores: el top-1 coincide con dash_gasto_proveedor",
    m_primero is not None and nombre_top.strip() in m_primero.group(1),
    f"pagina='{m_primero.group(1).strip() if m_primero else None}' vista='{nombre_top}'",
)

# ==============================================================================
# 7. Contra la fuente: ficha oficial de ARCE para 2 compras
# ==============================================================================
for id_compra in [TOP_ID, 1074933]:
    try:
        req = urllib.request.Request(
            f"https://www.comprasestatales.gub.uy/consultas/detalle/mostrar-llamado/1/id/{id_compra}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            arce = r.read().decode("utf-8", "replace")
        ok = "La compra seleccionada no existe" not in arce and str(id_compra) in arce
        check(f"ARCE: la compra {id_compra} existe en la fuente oficial", ok)
    except Exception as e:
        check(f"ARCE: la compra {id_compra} existe en la fuente oficial", False, str(e)[:80])

# ==============================================================================
print()
fallas = [r for r in resultados if not r[1]]
print(f"== {len(resultados) - len(fallas)}/{len(resultados)} pruebas OK ==")
sys.exit(1 if fallas else 0)
