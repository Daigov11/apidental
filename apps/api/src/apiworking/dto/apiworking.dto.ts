import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Ids de Apiworking: solo dígitos (pueden ser grandes, por eso viajan como texto). */
const EXT_ID = /^\d{1,20}$/;

export class ApiworkingLoginDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) usuario!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class ListExternalClientsQuery extends PaginationQuery {
  /// Solo el espejo local (sin consultar Apiworking): para la contingencia.
  @IsOptional() @Matches(/^(1|true)$/) local?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) search?: string;
}

export class SalesContextQuery {
  @IsOptional() @Matches(EXT_ID) idCaja?: string;
  @IsOptional() @Matches(EXT_ID) idTipoDocumento?: string;
}

export class SaleLineDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsInt() @Min(1) @Max(999) quantity!: number;
  /// Precio unitario en céntimos de sol, IGV incluido (aplicaIGV = 1).
  @IsInt() @Min(1) @Max(100_000_000) unitPriceCents!: number;
}

export class SaleDraftDto {
  /// id_cliente de la lista de clientes de Apiworking.
  @Matches(EXT_ID) customerId!: string;
  @Matches(EXT_ID) idCaja!: string;
  @Matches(EXT_ID) idTipoDocumento!: string;
  @Matches(EXT_ID) idSerie!: string;
  @Matches(EXT_ID) idMetodoPago!: string;
  /// Descripción de la venta o del servicio (queda en el registro local y en la observación del documento).
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) description!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SaleLineDto) lines!: SaleLineDto[];
  /// AAAA-MM-DD; por defecto, hoy (hora de Lima).
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) docDate?: string;
  @IsOptional() @IsUUID() patientId?: string;
  /// Cita atendida que se cobra (una sola venta vigente por cita).
  @IsOptional() @IsUUID() appointmentId?: string;
  /// Venta de contingencia que se está emitiendo ahora: no puede cambiar el cliente ni el monto.
  @IsOptional() @IsUUID() pendingSaleId?: string;
}

export class CreateSaleDto extends SaleDraftDto {
  /// SHA-256 de la vista previa que la persona aprobó: si el JSON cambió, no se envía.
  @Matches(/^[0-9a-f]{64}$/) approvedHash!: string;
  /// Clave local de idempotencia: la misma clave nunca envía dos veces la misma operación.
  @IsUUID() idempotencyKey!: string;
}

export class ListSalesQuery extends PaginationQuery {}

export class ReconcileSaleDto {
  /// REGISTERED: la persona verificó en Apiworking que el documento existe. NOT_REGISTERED: verificó que no existe.
  @IsString() @Matches(/^(REGISTERED|NOT_REGISTERED)$/) outcome!: 'REGISTERED' | 'NOT_REGISTERED';
  /// Evidencia obligatoria cuando outcome = REGISTERED.
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40) externalNumber?: string;
  @IsOptional() @Matches(EXT_ID) externalDocId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) note!: string;
}

export class VoidSaleDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) reason!: string;
}

export class CashOpenDraftDto {
  @Matches(EXT_ID) idCaja!: string;
  /// Turno de Apiworking (por defecto "1"; GET /api/CajaChica/turnos los lista).
  @IsOptional() @Matches(EXT_ID) idTurno?: string;
  /// Monto inicial en céntimos de sol (0 = abrir sin efectivo inicial).
  @IsInt() @Min(0) @Max(100_000_000) openingCents!: number;
}

/// Códigos de tipoDoc de Apiworking: DNI 1, RUC 6, CE 4, pasaporte 7, no domiciliado 0.
export class CustomerDraftDto {
  @Matches(/^(0|1|4|6|7)$/) docType!: string;
  @Transform(trim) @Matches(/^[A-Za-z0-9]{1,20}$/) docNumber!: string;
}

export class CustomerCreateDto extends CustomerDraftDto {
  /// Nombre de referencia para el espejo local (Apiworking completa el suyo y no lo devuelve).
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) name?: string;
  @Matches(/^[0-9a-f]{64}$/) approvedHash!: string;
}

export class CashCloseDraftDto {
  @Matches(EXT_ID) idCaja!: string;
  @IsOptional() @Matches(EXT_ID) idTurno?: string;
}

export class CashCloseDto extends CashCloseDraftDto {
  @Matches(/^[0-9a-f]{64}$/) approvedHash!: string;
}

export class CashOpenDto extends CashOpenDraftDto {
  /// SHA-256 de la vista previa que la persona aprobó.
  @Matches(/^[0-9a-f]{64}$/) approvedHash!: string;
}

/// Cobro en contingencia (Apiworking no responde): se guarda aquí y el dinero entra en la caja local.
export class ContingencyDto {
  @Matches(EXT_ID) customerId!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) description!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SaleLineDto) lines!: SaleLineDto[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) docDate?: string;
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsUUID() appointmentId?: string;
  /// Cuenta y tipo de operación de la caja local donde entra el cobro.
  @IsUUID() accountId!: string;
  @IsUUID() categoryId!: string;
  /// Clave de idempotencia: un reenvío no duplica ni la venta ni el movimiento de caja.
  @IsUUID() requestKey!: string;
}

export class BillingDraftQuery {
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsUUID() patientId?: string;
}
