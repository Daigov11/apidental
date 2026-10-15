import { createHash } from 'node:crypto';

/** Huella de integridad del contenido cerrado de una evolución (evidencia de que no cambió; NO es una firma). */
export const noteContentHash = (r: { itemId: string; version: number; visitId: string; patientId: string; body: string; followUp: string | null }): string =>
  createHash('sha256').update(JSON.stringify({ i: r.itemId, v: r.version, vi: r.visitId, p: r.patientId, b: r.body, f: r.followUp })).digest('hex');
