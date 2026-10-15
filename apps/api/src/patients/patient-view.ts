import { ageOn, formatDateOnly, isMinor } from './util/lima-date.js';

export interface PatientRow {
  id: string;
  firstName: string;
  lastName: string;
  secondLastName: string | null;
  birthDate: Date | null;
  sex: string | null;
  status: string;
  statusReason: string | null;
  createdBranchId: string | null;
  createdAt: Date;
  updatedAt: Date;
  identifiers: { type: string; number: string }[];
  contacts: { id: string; type: string; value: string; label: string | null; isPrimary: boolean }[];
}

export const fullName = (p: { firstName: string; lastName: string; secondLastName: string | null }): string =>
  [p.firstName, p.lastName, p.secondLastName].filter(Boolean).join(' ');

const pickContact = (p: PatientRow, type: string) =>
  p.contacts.find((c) => c.type === type && c.isPrimary) ?? p.contacts.find((c) => c.type === type) ?? null;

/**
 * Vista mínima (patient:read_basic): solo identificación y contacto. Se construye campo por
 * campo, nunca con spread de la entidad, para que un campo nuevo no se filtre por descuido.
 */
export function toBasicView(p: PatientRow) {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    secondLastName: p.secondLastName,
    fullName: fullName(p),
    status: p.status,
    identifiers: p.identifiers.map((i) => ({ type: i.type, number: i.number })),
    primaryMobile: pickContact(p, 'MOBILE')?.value ?? null,
    primaryEmail: pickContact(p, 'EMAIL')?.value ?? null,
  };
}

/** Vista completa (patient:read): demografía y todos los contactos vigentes. */
export function toFullView(p: PatientRow) {
  return {
    ...toBasicView(p),
    birthDate: formatDateOnly(p.birthDate),
    age: p.birthDate ? ageOn(p.birthDate) : null,
    isMinor: isMinor(p.birthDate),
    sex: p.sex,
    statusReason: p.statusReason,
    contacts: p.contacts.map((c) => ({
      id: c.id,
      type: c.type,
      value: c.value,
      label: c.label,
      isPrimary: c.isPrimary,
    })),
    createdBranchId: p.createdBranchId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
