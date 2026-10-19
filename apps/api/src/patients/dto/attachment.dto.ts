import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RequiredReason, trim } from './common.js';

export enum AttachmentCategoryDto {
  CONSENT = 'CONSENT',
  IDENTITY_DOCUMENT = 'IDENTITY_DOCUMENT',
  OTHER_ADMINISTRATIVE = 'OTHER_ADMINISTRATIVE',
  XRAY = 'XRAY',
  CLINICAL_PHOTO = 'CLINICAL_PHOTO',
  STUDY = 'STUDY',
  OTHER_CLINICAL = 'OTHER_CLINICAL',
}

/** Campos de texto del formulario multipart que acompañan al archivo. */
export class UploadAttachmentDto {
  @IsEnum(AttachmentCategoryDto)
  category!: AttachmentCategoryDto;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(300)
  description?: string;

  /** Solo con category=CONSENT: vincula el archivo a un consentimiento del mismo paciente. */
  @IsOptional() @IsUUID()
  consentId?: string;
}

export class RemoveAttachmentDto {
  @RequiredReason()
  reason!: string;
}
