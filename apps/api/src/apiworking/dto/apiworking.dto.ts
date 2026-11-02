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
