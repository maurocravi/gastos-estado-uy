import { XMLParser } from 'fast-xml-parser';

// Endpoint del servlet (sin ?wsdl: le hacemos POST del sobre SOAP directo)
const ENDPOINT = 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones';

export interface BcuRate {
  date: string; // YYYY-MM-DD
  code: number; // código de moneda BCU (ej 2225 = dólar billete)
  tcc: number;  // tipo de cambio comprador
  tcv: number;  // tipo de cambio vendedor
}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true });

/** Arma el sobre SOAP. Se pueden pedir varias monedas en una sola llamada. */
function buildEnvelope(codes: number[], from: string, to: string): string {
  const items = codes.map((c) => `<cot:item>${c}</cot:item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza">
  <soapenv:Header/>
  <soapenv:Body>
    <cot:wsbcucotizaciones.Execute>
      <cot:Entrada>
        <cot:Moneda>${items}</cot:Moneda>
        <cot:FechaDesde>${from}</cot:FechaDesde>
        <cot:FechaHasta>${to}</cot:FechaHasta>
        <cot:Grupo>0</cot:Grupo>
      </cot:Entrada>
    </cot:wsbcucotizaciones.Execute>
  </soapenv:Body>
</soapenv:Envelope>`;
}

type AnyObj = Record<string, unknown>;

/**
 * Recorre el árbol parseado y junta los nodos "dato" (los que tienen
 * Fecha + Moneda + TCC/TCV). Así no dependemos de los nombres raros de
 * elementos como "datoscotizaciones.dato".
 */
function collectDatos(node: unknown, out: AnyObj[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectDatos(n, out);
    return;
  }
  const obj = node as AnyObj;
  if ('Fecha' in obj && 'Moneda' in obj && ('TCC' in obj || 'TCV' in obj)) {
    out.push(obj);
    return;
  }
  for (const v of Object.values(obj)) collectDatos(v, out);
}

/** Busca el bloque respuestastatus para saber si la consulta fue OK. */
function findStatus(node: unknown): { status: number; mensaje: string } | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findStatus(n);
      if (r) return r;
    }
    return null;
  }
  const obj = node as AnyObj;
  if ('status' in obj && ('mensaje' in obj || 'codigoerror' in obj)) {
    return { status: Number(obj.status), mensaje: String(obj.mensaje ?? '') };
  }
  for (const v of Object.values(obj)) {
    const r = findStatus(v);
    if (r) return r;
  }
  return null;
}

/**
 * Consulta cotizaciones para un rango (máximo 31 días, límite del BCU).
 * Devuelve [] si el BCU responde sin datos (ej. un rango de solo feriados).
 */
export async function fetchCotizaciones(codes: number[], from: string, to: string): Promise<BcuRate[]> {
  // El BCU a veces tarda en aceptar la conexión más que el timeout de Node
  // (visto desde GitHub Actions): reintentos con espera creciente.
  let res: Response | undefined;
  for (let intento = 1; ; intento++) {
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
        body: buildEnvelope(codes, from, to),
      });
      break;
    } catch (e) {
      if (intento >= 3) throw e;
      console.warn(`  ⚠ BCU no respondió (intento ${intento}): ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, intento * 10_000));
    }
  }
  if (!res.ok) throw new Error(`BCU respondió HTTP ${res.status}`);

  const text = await res.text();
  const parsed = parser.parse(text);

  const status = findStatus(parsed);
  if (status && status.status !== 1) {
    // status != 1 suele ser "no hay datos para el período" (feriados) o un error de parámetros
    console.warn(`  ⚠ BCU status ${status.status}: ${status.mensaje} (${from}..${to})`);
    return [];
  }

  const datos: AnyObj[] = [];
  collectDatos(parsed, datos);

  return datos
    .map((d) => ({
      date: String(d.Fecha).slice(0, 10),
      code: Number(d.Moneda),
      tcc: Number(d.TCC),
      tcv: Number(d.TCV),
    }))
    .filter((r) => Number.isFinite(r.code) && Number.isFinite(r.tcv));
}
