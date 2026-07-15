// Estados OCDS en español. Fallback: el valor crudo.

const ESTADOS_COMPRA: Record<string, string> = {
  active: 'activa',
  complete: 'completa',
  cancelled: 'cancelada',
  unsuccessful: 'sin efecto',
  planned: 'planificada',
  award: 'adjudicada',
  tender: 'llamado',
  // Cuando el release más reciente no trae tender.status, el pipeline usa el
  // tag del release, que es un evento más que un estado:
  tenderUpdate: 'llamado actualizado',
  tenderAmendment: 'llamado modificado',
  tenderCancellation: 'llamado cancelado',
  awardUpdate: 'adjudicación ajustada',
};

const ESTADOS_ADJUDICACION: Record<string, string> = {
  active: 'vigente',
  pending: 'pendiente',
  cancelled: 'cancelada',
  unsuccessful: 'sin efecto',
};

export const estadoCompra = (s: string | null | undefined) =>
  s ? (ESTADOS_COMPRA[s] ?? s) : '—';

export const estadoAdjudicacion = (s: string | null | undefined) =>
  s ? (ESTADOS_ADJUDICACION[s] ?? s) : '—';
