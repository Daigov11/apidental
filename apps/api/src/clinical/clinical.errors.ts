import { ForbiddenException } from '@nestjs/common';

/**
 * 403 de acceso clínico que YA quedó auditado como CLINICAL_ACCESS_DENIED (con paciente y motivo): el filtro
 * global no vuelve a registrarlo como ACCESS_DENIED genérico.
 */
export class ClinicalAccessDeniedException extends ForbiddenException {
  constructor(
    message: string,
    readonly denialCode: string,
  ) {
    super({ message, code: denialCode });
  }
}
