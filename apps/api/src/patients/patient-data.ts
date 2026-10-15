import { BadRequestException } from '@nestjs/common';
import type { ContactInput, IdentifierInput } from './dto/patient.dto.js';
import { isFutureDate, toDateOnly } from './util/lima-date.js';
import { type ContactTypeCode, type IdentifierTypeCode, normalizeContact, normalizeIdentifier } from './util/normalize.js';

export interface PreparedContact {
  type: ContactTypeCode;
  value: string;
  valueKey: string | null;
  label: string | null;
  isPrimary: boolean;
}

export function parseBirthDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = toDateOnly(value);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('birthDate no es una fecha válida');
  }
  if (isFutureDate(value) || value < '1900-01-01') {
    throw new BadRequestException('birthDate fuera de rango (posterior a hoy o anterior a 1900)');
  }
  return date;
}

export function prepareIdentifier(input: Pick<IdentifierInput, 'type' | 'number'>): { type: IdentifierTypeCode; number: string } {
  const type = input.type as IdentifierTypeCode;
  return { type, number: normalizeIdentifier(type, input.number) };
}

export function identifierRow(
  clinicId: string,
  patientId: string,
  id: { type: IdentifierTypeCode; number: string },
  createdById: string,
) {
  return {
    clinicId,
    patientId,
    type: id.type,
    number: id.number,
    activeKey: `${clinicId}|${id.type}|${id.number}`,
    patientTypeKey: `${patientId}|${id.type}`,
    createdById,
  };
}

export function contactRow(clinicId: string, patientId: string, c: PreparedContact, createdById: string) {
  return {
    clinicId,
    patientId,
    type: c.type,
    value: c.value,
    valueKey: c.valueKey,
    label: c.label,
    isPrimary: c.isPrimary,
    primaryKey: c.isPrimary ? `${patientId}|${c.type}` : null,
    activeKey: c.valueKey ? `${patientId}|${c.type}|${c.valueKey}` : null,
    createdById,
  };
}

/** Valida y normaliza contactos del alta: un solo principal por tipo, sin repetidos. */
export function prepareContacts(inputs: ContactInput[]): PreparedContact[] {
  const out: PreparedContact[] = [];
  const primaries = new Set<string>();
  const seen = new Set<string>();
  for (const input of inputs) {
    const type = input.type as ContactTypeCode;
    const n = normalizeContact(type, input.value);
    const dupKey = `${type}|${n.valueKey ?? n.value}`;
    if (seen.has(dupKey)) throw new BadRequestException('Hay contactos repetidos en la solicitud');
    seen.add(dupKey);
    let isPrimary = input.isPrimary ?? !primaries.has(type);
    if (isPrimary && primaries.has(type)) {
      if (input.isPrimary) throw new BadRequestException(`Solo puede haber un contacto principal de tipo ${type}`);
      isPrimary = false;
    }
    if (isPrimary) primaries.add(type);
    out.push({ type, ...n, label: input.label ?? null, isPrimary });
  }
  return out;
}
