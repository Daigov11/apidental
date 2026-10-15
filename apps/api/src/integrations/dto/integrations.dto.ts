import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const REASON = 'Escriba el motivo (al menos 3 caracteres)';

export enum PaymentMethodDto { CASH = 'CASH', CARD = 'CARD', YAPE_PLIN = 'YAPE_PLIN', TRANSFER = 'TRANSFER' }
export enum ChargeStatusDto { PENDING = 'PENDING', PAID = 'PAID', VOIDED = 'VOIDED' }
export enum DocumentTypeDto { BOLETA = 'BOLETA', FACTURA = 'FACTURA' }
export enum DocumentStatusDto { PENDING_SEND = 'PENDING_SEND', SENT = 'SENT', ISSUED = 'ISSUED', REJECTED = 'REJECTED', RETRYABLE_ERROR = 'RETRYABLE_ERROR', NEEDS_RECONCILIATION = 'NEEDS_RECONCILIATION' }
export enum ScenarioDto { ISSUE = 'ISSUE', PENDING = 'PENDING', REJECT = 'REJECT', ERROR_THEN_OK = 'ERROR_THEN_OK', TIMEOUT = 'TIMEOUT' }
export enum OutboxStatusDto { PENDING = 'PENDING', DONE = 'DONE', FAILED = 'FAILED', SKIPPED = 'SKIPPED' }

export class CreateChargeDto {
  @IsUUID() patientId!: string;
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) description?: string;
  /// Monto en céntimos de sol. Si se omite y hay cita, se usa el precio del servicio.
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) amountCents?: number;
}
export class PayChargeDto {
  @IsEnum(PaymentMethodDto) method!: PaymentMethodDto;
  @IsInt() @Min(1) expectedVersion!: number;
}
export class VoidChargeDto {
  @Transform(trim) @IsString() @MinLength(3, { message: REASON }) @MaxLength(300) reason!: string;
  @IsInt() @Min(1) expectedVersion!: number;
}
export class ListChargesQuery extends PaginationQuery {
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsEnum(ChargeStatusDto) status?: ChargeStatusDto;
}
export class EmitDocumentDto {
  @IsEnum(DocumentTypeDto) type!: DocumentTypeDto;
  /// Solo FACTURA: RUC (11 dígitos) y razón social del cliente (datos ficticios en la demostración).
  @IsOptional() @Matches(/^\d{11}$/, { message: 'El RUC debe tener 11 dígitos' }) customerRuc?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) customerName?: string;
  /// Solo la simulación lo usa: qué debe responder el simulador.
  @IsOptional() @IsEnum(ScenarioDto) scenario?: ScenarioDto;
}
export class ListDocumentsQuery extends PaginationQuery {
  @IsOptional() @IsEnum(DocumentStatusDto) status?: DocumentStatusDto;
  @IsOptional() @IsUUID() chargeId?: string;
}
export class ListOutboxQuery extends PaginationQuery {
  @IsOptional() @IsEnum(OutboxStatusDto) status?: OutboxStatusDto;
}
export class RedeemDto {
  @IsInt() @Min(1) @Max(100_000) points!: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) reason?: string;
  /// Identificador de esta solicitud (idempotencia): repetirlo no canjea dos veces.
  @IsOptional() @IsUUID() requestId?: string;
}
