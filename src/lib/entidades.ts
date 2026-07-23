// Datos para las fichas de organismo y proveedor. Se cargan una sola vez
// por build (memo a nivel de módulo: los dos getStaticPaths comparten bundle)
// en ~100 requests paginados, en vez de una query por entidad (~6.200).
import { supabase, unwrap } from './supabase.js';

export interface Entidad {
  id: string;
  name: string;
  is_buyer: boolean;
  is_supplier: boolean;
}

export interface CompraResumen {
  ocid: string;
  id_compra: number | null;
  tender_title: string | null;
  item_principal: string | null;
  status: string | null;
  last_updated: string | null;
  organismo: string | null;
  buyer_id: string | null;
  adjudicaciones: number;
  total_uyu: number | null;
  outlier: string | null;
}

export interface Adjudicacion {
  award_pk: number;
  ocid: string;
  id_compra: number | null;
  buyer_id: string | null;
  supplier_id: string | null;
  status: string | null;
  award_date: string | null;
  total_uyu: number | null;
  items: number;
}

import { slugEntidad } from './slug.js';

export { slugEntidad };

/** Trae una vista completa paginando (PostgREST corta en 1000 filas). */
async function fetchTodo<T>(vista: string, orden: string): Promise<T[]> {
  const PAGINA = 1000;
  const filas: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    // Builder nuevo en cada vuelta: los builders de supabase-js son mutables.
    const pagina = unwrap<T[]>(
      await supabase
        .from(vista)
        .select('*')
        .order(orden)
        .range(desde, desde + PAGINA - 1),
      vista,
    );
    filas.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return filas;
}

export interface DatosEntidades {
  entidades: Entidad[];
  compraPorOcid: Map<string, CompraResumen>;
  comprasPorOrganismo: Map<string, CompraResumen[]>;
  adjudicacionesPorOrganismo: Map<string, Adjudicacion[]>;
  nombrePorId: Map<string, string>;
}

async function cargar(): Promise<DatosEntidades> {
  const [entidades, compras, adjudicaciones] = await Promise.all([
    fetchTodo<Entidad>('entities', 'id'),
    fetchTodo<CompraResumen>('dash_compras', 'ocid'),
    fetchTodo<Adjudicacion>('dash_adjudicaciones', 'award_pk'),
  ]);

  const slugs = new Map<string, string>();
  for (const e of entidades) {
    const slug = slugEntidad(e.id);
    const previo = slugs.get(slug);
    if (previo && previo !== e.id) {
      throw new Error(`Slug de entidad repetido: "${slug}" (${previo} y ${e.id})`);
    }
    slugs.set(slug, e.id);
  }

  const agrupar = <T,>(mapa: Map<string, T[]>, clave: string | null, fila: T) => {
    if (!clave) return;
    const lista = mapa.get(clave);
    if (lista) lista.push(fila);
    else mapa.set(clave, [fila]);
  };

  const compraPorOcid = new Map<string, CompraResumen>();
  const comprasPorOrganismo = new Map<string, CompraResumen[]>();
  for (const c of compras) {
    compraPorOcid.set(c.ocid, c);
    agrupar(comprasPorOrganismo, c.buyer_id, c);
  }

  const adjudicacionesPorOrganismo = new Map<string, Adjudicacion[]>();
  for (const a of adjudicaciones) {
    agrupar(adjudicacionesPorOrganismo, a.buyer_id, a);
  }

  const nombrePorId = new Map(entidades.map((e) => [e.id, e.name]));

  return {
    entidades,
    compraPorOcid,
    comprasPorOrganismo,
    adjudicacionesPorOrganismo,
    nombrePorId,
  };
}

let promesa: Promise<DatosEntidades> | null = null;
export function cargarEntidades(): Promise<DatosEntidades> {
  promesa ??= cargar();
  return promesa;
}

/** Agrupa adjudicaciones por contraparte y devuelve el ranking por monto. */
export function rankingContrapartes(
  adjudicaciones: Adjudicacion[],
  clave: (a: Adjudicacion) => string | null,
): { id: string; adjudicaciones: number; total_uyu: number }[] {
  const grupos = new Map<string, { id: string; adjudicaciones: number; total_uyu: number }>();
  for (const a of adjudicaciones) {
    const id = clave(a);
    if (!id) continue;
    const g = grupos.get(id) ?? { id, adjudicaciones: 0, total_uyu: 0 };
    g.adjudicaciones += 1;
    g.total_uyu += a.total_uyu ?? 0;
    grupos.set(id, g);
  }
  return [...grupos.values()].sort((x, y) => y.total_uyu - x.total_uyu);
}
