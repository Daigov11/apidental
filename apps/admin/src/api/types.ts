export interface UserInfo { id: string; email: string; firstName: string; lastName: string }
export interface ContextInfo { platform: boolean; clinic: { id: string; name: string } | null; branch: { id: string; name: string } | null }
export interface Me { user: UserInfo; context: ContextInfo | null; roles: string[]; permissions: string[] }
export interface LoginContext { assignmentId: string; role: { code: string; name: string }; clinic: { id: string; name: string } | null; branch: { id: string; name: string } | null }
export interface LoginBody { accessToken: string; user: UserInfo; contexts: LoginContext[]; pendingAccess?: boolean }
export type AuthMode = 'local' | 'apiworking'
export interface ContextSelected { accessToken: string }

export interface Branch { id: string; name: string }
export type AppointmentStatus = 'RESERVED' | 'CONFIRMED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
export interface Appointment {
  id: string; branchId: string; status: AppointmentStatus; statusLabel: string;
  startsAt: string; endsAt: string; date: string; time: string; durationMinutes: number;
  patient: { id: string; name: string; mobile: string | null };
  dentist: { userId: string; name: string };
  room: { id: string; name: string };
  service: { id: string; name: string; durationMinutes: number };
  notes: string | null; cancelReason: string | null; noShowReason: string | null; rescheduledCount: number;
  version: number; visitId?: string; hasVisit: boolean;
  actions: { confirm: boolean; reschedule: boolean; cancel: boolean; noShow: boolean; editNotes: boolean; startAttention: boolean; openVisit: boolean };
}
export interface CalendarAppointment { id: string; dentistUserId: string; roomId: string; startsAt: string; endsAt: string; status: AppointmentStatus; statusLabel: string; service: string; patient: { id: string; name: string } }
export interface Calendar {
  from: string; to: string;
  dentists: { userId: string; name: string }[];
  rooms: { id: string; branchId: string; name: string }[];
  windows: { dentistUserId: string; roomId: string | null; date: string; startsAt: string; endsAt: string }[];
  blocks: { id: string; dentistUserId: string | null; roomId: string | null; startsAt: string; endsAt: string; reason: string }[];
  appointments: CalendarAppointment[];
}
export interface AgendaService { id: string; name: string; durationMinutes: number; active: boolean }
export interface Slot { date: string; time: string; startsAt: string; dentistUserId: string; roomIds: string[] }
export interface Availability { durationMinutes: number; slots: Slot[] }

export interface PatientSummary {
  id: string; fullName: string; firstName: string; lastName: string; status: string; age: number | null; isMinor: boolean;
  identifiers: { type: string; number: string }[]; primaryMobile: string | null; primaryEmail?: string | null; birthDate: string | null;
}
export interface PatientDetail extends PatientSummary { guardianCount?: number; warnings?: unknown[] }

export interface VisitRow { id: string; visitNumber: number; status: string; reason: string | null; startedAt: string; closedAt: string | null }
export interface SheetActions {
  readOnly: boolean; canAddDiagnosis?: boolean; canAddProcedure?: boolean; canWriteEvolution?: boolean; canCloseEvolution?: boolean;
  canCorrectEvolution?: boolean; canCloseVisit?: boolean; closeVisitBlockedBy?: string[];
}
export interface Sheet {
  alerts: { advisory: boolean; items: { id: string; origin: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; label: string }[] };
  patient: { id: string; fullName: string; age: number | null; isMinor: boolean };
  allergyAssessment: { status: string; label: string; activeAllergyCount: number; version?: number };
  consent: { state: string; label: string };
  visit: { id: string; number: number; status: string; statusLabel: string; reason: string | null; startedAt: string; closedAt: string | null; version?: number };
  diagnoses: { id: string; version?: number; description: string; code?: string | null; certainty?: string; certaintyLabel: string; status?: string; statusLabel: string }[];
  procedures: { id: string; version?: number; name: string; notes: string | null; status?: string; statusLabel: string; closeBlockedMessage: string | null; canClose?: boolean }[];
  odontogram: { savedVersion: { version: number; savedAt: string; stateLabel: string } | null; hasDraft: boolean; formatNotice: string };
  evolution: { state: string; stateLabel: string; body: string | null; followUp: string | null; contentHidden: boolean; etag?: string } | null;
  actions: SheetActions;
  notice: string;
}
export interface ProcedureDefinition { id: string; code: string; name: string; requiresClinicalConsent: boolean; status: string }
export interface ToothEntry { status?: string; surfaces?: Record<string, { state: string; note?: string }>; marks?: string[]; note?: string }
export interface OdontogramVersion {
  version: number; state: string; stateLabel: string; kindLabel: string; dentition: string; dentitionLabel: string;
  data: { teeth: Record<string, ToothEntry>; notes?: string } | null; contentHidden: boolean; formatNotice: string;
  lastChange: { reason: string | null; at: string } | null;
  etag?: string; kind?: string;
}
export interface OdontogramView { official: OdontogramVersion | null; draft: OdontogramVersion | null; draftIsMine?: boolean; versionsCount: number; formatNotice: string }
export interface OdontogramSpecLite {
  toothStatuses: { code: string; label: string }[];
  surfaces: { code: string; label: string }[];
  surfaceStates: { code: string; label: string; color?: string; pattern?: 'hatch' | 'dots' | 'cross' | 'grid' | 'solid' }[];
  marks: { code: string; label: string }[];
  dentitions?: { code: string; label: string }[];
  layout?: { permanent: { upper: string[]; lower: string[] }; primary: { upper: string[]; lower: string[] } };
  cell?: { size: number; polygons: Record<'top' | 'bottom' | 'left' | 'right' | 'center', number[][]> };
  limits?: { toothNote?: number; surfaceNote?: number; generalNotes?: number };
}
export type Dentition = 'PERMANENT' | 'PRIMARY' | 'MIXED';
export interface OdontogramDoc { schema: string; schemaVersion: number; teeth: Record<string, ToothEntry>; notes?: string }

// ------------------------------------------------------------------ 4.1 simulación (cobros, comprobantes, fidelización)
export interface SimulationInfo { active: true; label: string; demoMark: string }
export interface IntegrationStatus { mode: 'off' | 'mock'; simulation: SimulationInfo | null; scenarios: { code: string; label: string }[] }
export type DocStatus = 'PENDING_SEND' | 'SENT' | 'ISSUED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NEEDS_RECONCILIATION';
export interface BillingDocument {
  id: string; chargeId: string; type: 'BOLETA' | 'FACTURA'; typeLabel: string; number: string; status: DocStatus; statusLabel: string;
  customer: { name: string; docType: string; docNumber: string }; amountText: string; igvText: string; subtotalText: string;
  demoMark: string; simulated: true; providerRef: string | null; rejectionReason: string | null; scenarioLabel: string | null;
  attempts: number; issuedAt: string | null; createdAt: string; description?: string; patientName?: string;
  actions: { retry: boolean; reconcile: boolean; pdf: boolean };
}
export interface Charge {
  id: string; patient: { id: string; name: string }; appointmentId: string | null; description: string; amountCents: number; amountText: string;
  status: 'PENDING' | 'PAID' | 'VOIDED'; statusLabel: string; paymentMethod: string | null; paymentMethodLabel: string | null; paidAt: string | null;
  createdAt: string; version: number; document: BillingDocument | null;
  actions: { pay: boolean; void: boolean; emitDocument: boolean };
}
export interface OutboxItem { id: string; kind: string; kindLabel: string; status: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED'; statusLabel: string; attempts: number; note: string | null; reference: string; createdAt: string }
export type LoyaltySummary =
  | { simulation: SimulationInfo; consent: 'MISSING'; message: string }
  | {
      simulation: SimulationInfo; consent: 'GRANTED'; rule: string;
      points: { balance: number; accrued: number; redeemed: number; tier: string; recent: { kind: string; kindLabel: string; points: number; reason: string | null; at: string }[] };
      nfc: { cardLabel: string; status: string; tapsLast30Days: number; lastTapAt: string | null; tier: string };
    };
export interface ReviewSummary { simulation: SimulationInfo; average: number; total: number; requestsSent: number; queued: number; recent: { rating: number; comment: string; label: string }[] }

// ------------------------------------------------------------------ solicitudes de cita (web pública)
export type BookingStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export interface BookingRequest {
  id: string; reference: string; status: BookingStatus; statusLabel: string; createdAt: string;
  branch: { id: string; name: string }; service: { id: string; name: string; durationMinutes: number };
  desiredStartsAt: string; date: string; time: string;
  person: { firstName: string; lastName: string; secondLastName: string | null; documentType: string | null; documentNumber: string | null; mobile: string; email: string | null };
  notes: string | null; appointmentId: string | null; patientId: string | null; rejectReason: string | null; decidedAt: string | null;
}

export interface AttachmentRow {
  id: string; category: string; originalName: string; mimeType: string; sizeBytes: number; description: string | null;
  status: 'ACTIVE' | 'REMOVED'; uploadedAt: string;
}
export interface PrescriptionItem { medication: string; dose: string | null; frequency: string | null; duration: string | null; instructions: string | null }
export interface Prescription {
  id: string; number: string; patientId: string; patientName?: string; visitId: string | null; prescriber: { id: string; name: string };
  diagnosis: string | null; notes: string | null; status: 'ACTIVE' | 'DELETED'; lastEmailedAt: string | null; createdAt: string; items: PrescriptionItem[];
}

export interface CashAccountRow { id: string; name: string; kind: string; kindLabel: string; active: boolean; allowNegative: boolean; openingCents: number | null; incomeCents: number; expenseCents: number; balanceCents: number }
export interface CashSummary {
  branch: { id: string; name: string }; register: { id: string; name: string } | null;
  session: { id: string; openedAt: string; openedBy: string; openNotes: string | null } | null; lastClosedAt: string | null;
  accounts: CashAccountRow[]; totals: { openingCents: number; incomeCents: number; expenseCents: number; balanceCents: number };
}
export interface CashConfig {
  accounts: { id: string; name: string; kind: string; kindLabel: string; allowNegative: boolean; active: boolean }[];
  categories: { id: string; flow: 'INCOME' | 'EXPENSE'; name: string; active: boolean }[];
  users: { id: string; name: string }[];
}
export interface CashMovement {
  id: string; flow: 'INCOME' | 'EXPENSE'; flowLabel: string; kind: 'NORMAL' | 'OPENING' | 'COUNT_ADJUSTMENT'; kindLabel: string; description: string; operationNumber: string | null;
  amountCents: number; amountText: string; occurredAt: string; status: 'ACTIVE' | 'VOIDED'; voidReason: string | null; voidedBy: string | null;
  account: { id: string; name: string; kind: string }; category: { id: string; name: string } | null; user: { id: string; name: string };
}
export interface CashMovementList { items: CashMovement[]; total: number; incomeCents: number; expenseCents: number }

// --- Apiworking real: clientes y ventas por registro-documento ---
export interface AwStatus { configured: boolean; read: boolean; write: boolean; tenant: string | null; session: boolean }
export interface AwCustomer { id: string; personId: string; name: string; email: string; docType: string; docNumber: string; phone: string; whatsapp: string; personType: string; active: boolean }
export interface AwOption { id: string; name: string }
export interface AwContext {
  cajas: { id: string; name: string; branch: string }[]; authorizedConfigured: boolean;
  opened?: boolean; documentTypes?: AwOption[]; series?: { id: string; serie: string }[]; paymentMethods?: AwOption[];
}
export interface AwLine { name: string; quantity: number; unitPriceCents: number }
export interface AwDraft {
  customerId: string; idCaja: string; idTipoDocumento: string; idSerie: string; idMetodoPago: string;
  description: string; lines: AwLine[]; docDate?: string;
}
export interface AwPreview {
  request: unknown; hash: string; totalCents: number; totalText: string; serie: string;
  customer: AwCustomer; suggestedDocument: 'FACTURA' | 'BOLETA' | 'NOTA_DE_VENTA'; mode: 'LIVE' | 'READ_ONLY'; writeEnabled: boolean; warnings: string[];
}
export type AwDocStatus = 'PENDING' | 'SENT' | 'REJECTED' | 'PENDING_RECONCILIATION';
export interface AwSale {
  id: string; description: string; customer: { name: string; docType: string; docNumber: string };
  totalCents: number; totalText: string; lines: AwLine[]; docDate: string; serie: string | null;
  docStatus: AwDocStatus; docStatusLabel: string; paymentStatus: 'NO_EVIDENCE' | 'CONFIRMED_REMOTE' | 'CONFIRMED_RECONCILED'; paymentStatusLabel: string;
  voidStatus: 'IN_PROGRESS' | 'VOIDED' | 'TO_RECONCILE' | null; voidStatusLabel: string | null;
  externalDocId: string | null; externalNumber: string | null; failureReason: string | null; attemptedAt: string | null; createdAt: string;
  actions: { verify: boolean; reconcile: boolean; void: boolean };
}
export interface AwVerify { sale: AwSale; paidCents?: number; paymentMessage?: string; candidates?: { number: string; status: string; totalCents: number | null; balanceCents: number | null }[] }
