import { randomUUID } from 'node:crypto';
import type { OcdsRelease, OcdsItem, OcdsAward } from './ocds.js';
import type { EntityRow, PurchaseRow, AwardRow, AwardItemRow } from './db.js';

/**
 * Acumulador en memoria. Procesamos todo el mes acá y recién después
 * escribimos a la base, para poder deduplicar y armar los FKs sin ir y volver.
 *
 * Nota de modelado (a revisar al escalar, paso 5): usamos el party.id local
 * del release como clave de entidad. En ARCE los ids de proveedores vienen
 * con prefijo de RUT y los de organismos son códigos estables, así que en la
 * práctica funciona; una resolución de entidades más estricta queda para después.
 */
export class Accumulator {
  readonly entities = new Map<string, EntityRow>();
  readonly purchases = new Map<string, PurchaseRow>();
  // clave: `${ocid}::${award_id}` -> award + sus items (release más reciente gana)
  readonly awards = new Map<
    string,
    { award: AwardRow; items: AwardItemRow[]; releaseDate: string | null }
  >();

  private touchEntity(id: string, name: string, legalName: string | null, role: 'buyer' | 'supplier') {
    const existing = this.entities.get(id);
    if (existing) {
      if (role === 'buyer') existing.is_buyer = true;
      else existing.is_supplier = true;
      if (!existing.legal_name && legalName) existing.legal_name = legalName;
      if ((!existing.name || existing.name === id) && name) existing.name = name;
      return;
    }
    this.entities.set(id, {
      id,
      name: name || id,
      legal_name: legalName,
      is_buyer: role === 'buyer',
      is_supplier: role === 'supplier',
    });
  }

  add(release: OcdsRelease): void {
    const ocid = release.ocid;
    if (!ocid) return;

    // --- parties -> entities ---
    for (const p of release.parties ?? []) {
      if (!p.id) continue;
      const roles = p.roles ?? [];
      const legalName = p.identifier?.legalName ?? null;
      if (roles.includes('buyer') || roles.includes('procuringEntity')) {
        this.touchEntity(p.id, p.name ?? '', legalName, 'buyer');
      }
      if (roles.includes('supplier')) {
        this.touchEntity(p.id, p.name ?? '', legalName, 'supplier');
      }
    }

    // Aseguramos que el buyer del release exista como entidad
    if (release.buyer?.id) {
      this.touchEntity(release.buyer.id, release.buyer.name ?? '', null, 'buyer');
    }

    // --- purchase (nivel ocid) ---
    // Merge por fecha de release, no por orden de procesamiento (el RSS no es
    // cronológico): el más reciente define status/fechas, pero un campo null
    // nunca pisa un valor ya visto (las adjudicaciones no traen tender.title
    // ni tender.description y borraban lo que había puesto el llamado).
    const prev = this.purchases.get(ocid);
    const date = release.date ?? null;
    const newer = !prev?.last_updated || (date !== null && date >= prev.last_updated);

    const title = release.tender?.title ?? null;
    const description = texto(release.tender?.description);
    const status = release.tender?.status ?? release.tag?.[0] ?? null;
    const buyerId = release.buyer?.id ?? null;

    this.purchases.set(ocid, {
      ocid,
      id_compra: idCompraFromOcid(ocid),
      buyer_id: newer ? (buyerId ?? prev?.buyer_id ?? null) : (prev?.buyer_id ?? buyerId),
      tender_title: newer ? (title ?? prev?.tender_title ?? null) : (prev?.tender_title ?? title),
      tender_description: newer
        ? (description ?? prev?.tender_description ?? null)
        : (prev?.tender_description ?? description),
      status: newer ? (status ?? prev?.status ?? null) : (prev?.status ?? status),
      last_updated: newer ? (date ?? prev?.last_updated ?? null) : (prev?.last_updated ?? date),
    });

    // --- awards + items ---
    for (const aw of release.awards ?? []) {
      if (!aw.id) continue;
      const key = `${ocid}::${aw.id}`;

      // Merge por fecha de release, como purchases: no por orden de
      // procesamiento (los fetches son concurrentes y el RSS no es
      // cronológico), y campo por campo: los ajuste_adjudicacion de ARCE
      // traen los items corregidos pero omiten status/date/suppliers del
      // award original, así que null nunca pisa un valor ya visto. Los items
      // quedan los del release más reciente que traiga alguno.
      const prev = this.awards.get(key);
      const newer = !prev?.releaseDate || (date !== null && date >= prev.releaseDate);

      // Aseguramos que el proveedor exista como entidad (por si no vino en parties)
      const sup = aw.suppliers?.[0];
      if (sup?.id) this.touchEntity(sup.id, sup.name ?? '', null, 'supplier');

      const visto = {
        supplier_id: sup?.id ?? null,
        status: aw.status ?? null,
        award_date: dateOnly(aw.date),
        notice_url: noticeUrl(aw),
      };
      const base = prev?.award;
      const pick = (k: keyof typeof visto) =>
        newer ? (visto[k] ?? base?.[k] ?? null) : (base?.[k] ?? visto[k]);

      const awardUuid = base?.id ?? randomUUID();
      const award: AwardRow = {
        id: awardUuid,
        ocid,
        award_id: aw.id,
        supplier_id: pick('supplier_id'),
        status: pick('status'),
        award_date: pick('award_date'),
        notice_url: pick('notice_url'),
      };

      const nuevos: AwardItemRow[] = (aw.items ?? []).map((it) => itemRow(awardUuid, it));
      const items = newer
        ? nuevos.length
          ? nuevos
          : (prev?.items ?? [])
        : prev!.items.length
          ? prev!.items
          : nuevos;

      this.awards.set(key, {
        award,
        items,
        releaseDate: newer ? (date ?? prev?.releaseDate ?? null) : prev!.releaseDate,
      });
    }
  }
}

/**
 * Merge de una compra recién acumulada contra la fila que ya está en la base.
 * Misma regla que dentro de una corrida (más reciente gana, null nunca pisa)
 * pero ENTRE corridas: el upsert reescribe la fila entera y los releases de
 * adjudicación no traen `tender.title` ni `tender.description`, así que sin
 * esto la corrida del cron borra el título y la descripción que había dejado
 * el llamado meses atrás (es lo que le pasó a la compra 1325850).
 */
export function mergePurchase(nueva: PurchaseRow, vieja?: PurchaseRow): PurchaseRow {
  if (!vieja) return nueva;
  const newer = esPosterior(nueva.last_updated, vieja.last_updated);
  const pick = <K extends keyof PurchaseRow>(k: K): PurchaseRow[K] =>
    newer ? (nueva[k] ?? vieja[k]) : (vieja[k] ?? nueva[k]);

  return {
    ocid: nueva.ocid,
    id_compra: nueva.id_compra ?? vieja.id_compra,
    buyer_id: pick('buyer_id'),
    tender_title: pick('tender_title'),
    tender_description: pick('tender_description'),
    status: pick('status'),
    last_updated: pick('last_updated'),
  };
}

/**
 * ¿`a` es igual o posterior a `b`? Comparamos como instantes y no como texto:
 * el feed trae "2026-07-25T00:25:09Z" y PostgREST devuelve el mismo momento
 * como "2026-07-25T00:25:09+00:00" ('+' < 'Z' en ASCII haría ver más viejo lo
 * que está en la base).
 */
function esPosterior(a: string | null, b: string | null): boolean {
  if (!b) return true;
  if (!a) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta >= tb;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function itemRow(awardUuid: string, it: OcdsItem): AwardItemRow {
  const value = it.unit?.value ?? it.value ?? {};
  return {
    award_id: awardUuid,
    description: it.description ?? null,
    classification_id: it.classification?.id ?? null,
    classification_desc: it.classification?.description ?? null,
    quantity: it.quantity ?? null,
    unit_name: it.unit?.name ?? null,
    amount: value.amount ?? null,
    currency: value.currency ?? null,
  };
}

/**
 * URL del acta de adjudicación (documento awardNotice). ARCE la publica en
 * http:// pero el mismo recurso responde por https://, así que normalizamos
 * para no meter links http en una página https.
 */
function noticeUrl(aw: OcdsAward): string | null {
  const url = aw.documents?.find((d) => d.documentType === 'awardNotice' && d.url)?.url;
  return url ? url.replace(/^http:\/\//, 'https://') : null;
}

/**
 * Texto libre del feed: recorta espacios (varias descripciones vienen con
 * tabs o espacios al principio) y trata el vacío como ausente.
 */
export function texto(s?: string | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/** ocid "ocds-yfs5dr-1352252" -> 1352252 */
function idCompraFromOcid(ocid: string): number | null {
  const last = ocid.split('-').pop();
  const n = last ? Number(last) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * "2026-06-15T00:00:00" -> "2026-06-15".
 * Valida el año: en ARCE aparecen typos como "0026-04-10" o "0206-03-19";
 * una fecha absurda rompe el paso de cotizaciones (dispararía un rango
 * gigante de consultas al BCU), así que preferimos dejarla en null.
 * El dato original queda igual en releases.raw para reprocesar.
 */
function dateOnly(d?: string): string | null {
  if (!d) return null;
  const iso = d.slice(0, 10);
  const year = Number(iso.slice(0, 4));
  const maxYear = new Date().getUTCFullYear() + 1;
  if (!Number.isFinite(year) || year < 2000 || year > maxYear) return null;
  return iso;
}
