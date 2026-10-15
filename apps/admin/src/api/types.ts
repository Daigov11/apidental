export interface UserInfo { id: string; email: string; firstName: string; lastName: string }
export interface ContextInfo { platform: boolean; clinic: { id: string; name: string } | null; branch: { id: string; name: string } | null }
export interface Me { user: UserInfo; context: ContextInfo | null; roles: string[]; permissions: string[] }
export interface LoginContext { assignmentId: string; role: { code: string; name: string }; clinic: { id: string; name: string } | null; branch: { id: string; name: string } | null }
export interface LoginBody { accessToken: string; user: UserInfo; contexts: LoginContext[] }
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
  identifiers: { type: string; number: string }[]; primaryMobile: string | null; birthDate: string | null;
}
export interface PatientDetail extends PatientSummary { guardianCount?: number; warnings?: unknown[] }

export interface VisitRow { id: string; visitNumber: number; status: string; reason: string | null; startedAt: string; closedAt: string | null }
export interface Sheet {
  alerts: { advisory: boolean; items: { id: string; origin: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; label: string }[] };
  patient: { id: string; fullName: string; age: number | null; isMinor: boolean };
  allergyAssessment: { status: string; label: string; activeAllergyCount: number };
  consent: { state: string; label: string };
  visit: { id: string; number: number; status: string; statusLabel: string; reason: string | null; startedAt: string; closedAt: string | null };
  diagnoses: { id: string; description: string; certaintyLabel: string; statusLabel: string }[];
  procedures: { id: string; name: string; notes: string | null; statusLabel: string; closeBlockedMessage: string | null }[];
  odontogram: { savedVersion: { version: number; savedAt: string; stateLabel: string } | null; hasDraft: boolean; formatNotice: string };
  evolution: { state: string; stateLabel: string; body: string | null; followUp: string | null; contentHidden: boolean } | null;
  actions: { readOnly: boolean };
  notice: string;
}
export interface ToothEntry { status?: string; surfaces?: Record<string, { state: string; note?: string }>; marks?: string[]; note?: string }
export interface OdontogramVersion {
  version: number; state: string; stateLabel: string; kindLabel: string; dentition: string; dentitionLabel: string;
  data: { teeth: Record<string, ToothEntry>; notes?: string } | null; contentHidden: boolean; formatNotice: string;
  lastChange: { reason: string | null; at: string } | null;
}
export interface OdontogramView { official: OdontogramVersion | null; draft: OdontogramVersion | null; versionsCount: number; formatNotice: string }
export interface OdontogramSpecLite {
  toothStatuses: { code: string; label: string }[];
  surfaces: { code: string; label: string }[];
  surfaceStates: { code: string; label: string }[];
  marks: { code: string; label: string }[];
}
