import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Tipos de fila (espejo del esquema en Postgres)
// ---------------------------------------------------------------------------

export interface EntityRow {
  id: string;
  name: string;
  legal_name: string | null;
  is_buyer: boolean;
  is_supplier: boolean;
}

export interface PurchaseRow {
  ocid: string;
  id_compra: number | null;
  buyer_id: string | null;
  tender_title: string | null;
  status: string | null;
  last_updated: string | null;
}

export interface AwardRow {
  id: string; // uuid generado en el cliente para poder linkear los items
  ocid: string;
  award_id: string;
  supplier_id: string | null;
  status: string | null;
  award_date: string | null;
  notice_url: string | null;
}

export interface AwardItemRow {
  award_id: string; // uuid -> awards.id
  description: string | null;
  classification_id: string | null;
  classification_desc: string | null;
  quantity: number | null;
  unit_name: string | null;
  amount: number | null;
  currency: string | null;
  // amount_uyu / amount_usd quedan null: se completan en el paso de normalización
}

export interface ReleaseRow {
  release_id: string;
  ocid: string | null;
  tag: string | null;
  release_date: string | null;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Helpers de escritura por lote
// ---------------------------------------------------------------------------

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function upsertRows<T extends object>(
  table: string,
  rows: T[],
  onConflict: string,
): Promise<void> {
  for (const part of chunk(rows, config.dbChunkSize)) {
    const { error } = await supabase.from(table).upsert(part, { onConflict });
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
}

export async function insertRows<T extends object>(table: string, rows: T[]): Promise<void> {
  for (const part of chunk(rows, config.dbChunkSize)) {
    const { error } = await supabase.from(table).insert(part);
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

/** Borra las adjudicaciones (y por cascade sus items) de un conjunto de ocids. */
export async function deleteAwardsForOcids(ocids: string[]): Promise<void> {
  for (const part of chunk(ocids, config.dbChunkSize)) {
    const { error } = await supabase.from('awards').delete().in('ocid', part);
    if (error) throw new Error(`delete awards: ${error.message}`);
  }
}
