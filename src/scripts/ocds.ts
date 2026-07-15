import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Tipos OCDS (parciales: solo lo que usamos en el paso 1)
// ---------------------------------------------------------------------------

export interface OcdsValue {
  amount?: number;
  currency?: string;
}

export interface OcdsItem {
  id?: string;
  description?: string;
  classification?: { id?: string; description?: string };
  quantity?: number;
  unit?: { name?: string; value?: OcdsValue };
  value?: OcdsValue; // fallback: algunos releases ponen el valor a nivel item
}

export interface OcdsParty {
  id?: string;
  name?: string;
  identifier?: { id?: string; legalName?: string; scheme?: string };
  roles?: string[];
}

export interface OcdsDocument {
  id?: string;
  url?: string;
  documentType?: string;
}

export interface OcdsAward {
  id?: string;
  status?: string;
  date?: string;
  suppliers?: Array<{ id?: string; name?: string }>;
  items?: OcdsItem[];
  documents?: OcdsDocument[];
}

export interface OcdsRelease {
  ocid: string;
  id?: string;
  date?: string;
  tag?: string[];
  buyer?: { id?: string; name?: string };
  parties?: OcdsParty[];
  tender?: { title?: string; status?: string };
  awards?: OcdsAward[];
}

/** Un "release package" envuelve uno o más releases. */
interface OcdsReleasePackage {
  releases?: OcdsRelease[];
}

/** Item del RSS ya normalizado. */
export interface RssEntry {
  releaseId: string; // ej "adjudicacion-1352252"
  tag: string;       // category del RSS: tender | award | awardUpdate | ...
  link: string;
}

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

const xml = new XMLParser({ ignoreAttributes: true, trimValues: true });

/** Extrae el release_id del último segmento del link. */
function releaseIdFromLink(link: string): string {
  return link.split('/').filter(Boolean).pop() ?? link;
}

/**
 * Trae la lista de releases publicados en un mes/año.
 * Endpoint: /ocds/rss/AAAA/MM
 */
export async function fetchMonthlyReleaseList(year: number, month: number): Promise<RssEntry[]> {
  const mm = String(month).padStart(2, '0');
  const url = `${config.ocdsBase}/rss/${year}/${mm}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS ${year}/${mm} respondió ${res.status}`);
  const body = await res.text();

  const parsed = xml.parse(body);
  const rawItems = parsed?.rss?.channel?.item;
  if (!rawItems) return [];

  // fast-xml-parser devuelve objeto si hay un solo item, array si hay varios.
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.map((it: Record<string, unknown>): RssEntry => {
    const link = String(it.link ?? '');
    return {
      link,
      releaseId: String(it.guid ?? releaseIdFromLink(link)),
      tag: String(it.category ?? ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Release individual
// ---------------------------------------------------------------------------

/**
 * Trae un release por id. El endpoint devuelve un "release package";
 * contemplamos también el caso de un release plano por robustez.
 */
export async function fetchRelease(releaseId: string): Promise<OcdsRelease | null> {
  const url = `${config.ocdsBase}/release/${releaseId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`release ${releaseId} respondió ${res.status}`);

  const json = (await res.json()) as OcdsReleasePackage | OcdsRelease;

  if ('releases' in json && Array.isArray(json.releases)) {
    return json.releases[0] ?? null;
  }
  if ('ocid' in json && json.ocid) {
    return json as OcdsRelease;
  }
  return null;
}
