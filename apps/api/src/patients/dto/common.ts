import { Transform } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Motivo obligatorio (3-300 caracteres) para cambios que deben quedar justificados en auditoría. */
export const RequiredReason = () =>
  applyDecorators(Transform(trim), IsString(), MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' }), MaxLength(300));

export const OptionalReason = () =>
  applyDecorators(IsOptional(), Transform(trim), IsString(), MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' }), MaxLength(300));

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
