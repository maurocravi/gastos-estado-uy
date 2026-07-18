// Los ids de comprador de ARCE son "inciso-unidadEjecutora" del Presupuesto
// Nacional. Ocho ministerios llaman «Dirección General de Secretaría» a una
// de sus unidades ejecutoras y el feed no trae ninguna referencia al inciso,
// así que el nombre solo no alcanza para distinguirlas: se muestra con la
// sigla del ministerio. Módulo sin dependencias: lo importan también los
// scripts de cliente.
const SIGLAS: Record<string, string> = {
  '2': 'Presidencia',
  '3': 'MDN',
  '4': 'MI',
  '5': 'MEF',
  '6': 'MRREE',
  '7': 'MGAP',
  '8': 'MIEM',
  '9': 'MINTUR',
  '10': 'MTOP',
  '11': 'MEC',
  '12': 'MSP',
  '13': 'MTSS',
  '14': 'MVOT',
  '15': 'MIDES',
  '36': 'MA',
};

const sinTildes = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

// Único nombre de comprador repetido exacto en el feed (8 veces, uno por
// ministerio). Las variantes tipo «Dir. Gral. de Secretaría (M.E.F.)» ya se
// identifican solas y pasan sin tocar.
const HOMONIMO = 'direccion general de secretaria';

/**
 * Nombre de organismo para mostrar: «Dirección General de Secretaría» se
 * desambigua con la sigla del inciso («… (MEC)»); todo otro nombre pasa igual.
 */
export function nombreOrganismo(name: string, id?: string | null): string;
export function nombreOrganismo(name: string | null, id?: string | null): string | null;
export function nombreOrganismo(name: string | null, id?: string | null): string | null {
  if (!name || sinTildes(name) !== HOMONIMO) return name;
  const sigla = id ? SIGLAS[id.split('-')[0]] : undefined;
  return sigla ? `${name.trim()} (${sigla})` : name;
}
