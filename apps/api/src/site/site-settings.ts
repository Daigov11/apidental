import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequirePermissions } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { clinicScope } from '../patients/patient-access.js';
import type { UploadedFileLike } from '../patients/attachments.service.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';

/*
 * Página pública para agendar, personalizable por clínica: nombre, logo, color, textos de portada, contacto,
 * «Cómo funciona», preguntas frecuentes, aviso de privacidad y qué secciones se ven. Un campo vacío = texto por defecto
 * de la página (apps/site/index.html). La página pinta todo con textContent: nunca se interpreta HTML.
 */

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const COLOR = /^#[0-9a-fA-F]{6}$/;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 512 * 1024;

export class SiteStepDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) title!: string;
  @Transform(trim) @IsString() @MaxLength(300) text!: string;
}
export class SiteFaqDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(160) question!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(800) answer!: string;
}
export class SiteSectionsDto {
  @IsBoolean() services!: boolean;
  @IsBoolean() howItWorks!: boolean;
  @IsBoolean() branches!: boolean;
  @IsBoolean() faq!: boolean;
}

export class UpdateSiteSettingsDto {
  /** Nombre que se muestra (cabecera, título de la pestaña). Vacío = nombre de la clínica. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) displayName?: string;
  /** Color principal #RRGGBB. Vacío = color del producto. */
  @IsOptional() @Transform(trim) @Matches(/^(#[0-9a-fA-F]{6})?$/, { message: 'El color debe tener el formato #RRGGBB' }) primaryColor?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) heroEyebrow?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) heroTitle?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(400) heroLead?: string;
  /** Teléfono para llamar (texto libre: «(01) 555-1234», «930 607 986»). */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) @Matches(/^[0-9+()\s-]*$/, { message: 'El teléfono solo admite números, espacios, +, ( ) y -' }) phone?: string;
  /** WhatsApp: 9 dígitos de Perú o con código de país. Muestra el botón flotante de WhatsApp. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) @Matches(/^(\+?\d[\d\s]{7,18})?$/, { message: 'WhatsApp: escriba solo números, con o sin código de país' }) whatsapp?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => SiteStepDto) steps?: SiteStepDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => SiteFaqDto) faqs?: SiteFaqDto[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1500) privacyText?: string;
  @IsOptional() @ValidateNested() @Type(() => SiteSectionsDto) sections?: SiteSectionsDto;
}

/** Lo que se guarda en `clinics.site_settings` (sin nombre ni color, que van en las columnas de marca). */
export interface SiteContent {
  heroEyebrow: string;
  heroTitle: string;
  heroLead: string;
  phone: string;
  whatsapp: string;
  contactEmail: string;
  steps: { title: string; text: string }[];
  faqs: { question: string; answer: string }[];
  privacyText: string;
  sections: { services: boolean; howItWorks: boolean; branches: boolean; faq: boolean };
}

const DEFAULT_SECTIONS: SiteContent['sections'] = { services: true, howItWorks: true, branches: true, faq: true };

/** Lee el JSON guardado tolerando datos viejos o incompletos (nunca confía en la forma). */
export function readContent(raw: unknown): SiteContent {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const list = <T>(k: string, pick: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).flatMap((x) => (x && typeof x === 'object' ? [pick(x as Record<string, unknown>)] : [])).filter((x): x is T => x !== null) : [];
  const sec = (o['sections'] && typeof o['sections'] === 'object' ? o['sections'] : {}) as Record<string, unknown>;
  const flag = (k: keyof SiteContent['sections']) => (typeof sec[k] === 'boolean' ? (sec[k] as boolean) : DEFAULT_SECTIONS[k]);
  return {
    heroEyebrow: str('heroEyebrow'),
    heroTitle: str('heroTitle'),
    heroLead: str('heroLead'),
    phone: str('phone'),
    whatsapp: str('whatsapp'),
    contactEmail: str('contactEmail'),
    steps: list('steps', (x) => (typeof x['title'] === 'string' && typeof x['text'] === 'string' ? { title: x['title'], text: x['text'] } : null)),
    faqs: list('faqs', (x) => (typeof x['question'] === 'string' && typeof x['answer'] === 'string' ? { question: x['question'], answer: x['answer'] } : null)),
    privacyText: str('privacyText'),
    sections: { services: flag('services'), howItWorks: flag('howItWorks'), branches: flag('branches'), faq: flag('faq') },
  };
}

/** Número para wa.me: solo dígitos y con 51 si es un celular peruano de 9 dígitos. */
export function whatsappNumber(v: string): string | null {
  const d = v.replace(/\D/g, '');
  if (!d) return null;
  if (/^9\d{8}$/.test(d)) return '51' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** Firma de archivo: el tipo declarado por el navegador no basta. */
function sniffImage(b: Buffer): (typeof LOGO_TYPES)[number] | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export interface SiteSettingsView extends SiteContent {
  clinicName: string;
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
}

@Injectable()
export class SiteSettingsService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb, private readonly audit: AuditService) {}

  private async load(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true, brandDisplayName: true, brandPrimaryColor: true, siteSettings: true, siteLogoUpdatedAt: true },
    });
    if (!c) throw new NotFoundException('Clínica no encontrada');
    return c;
  }

  private view(c: Awaited<ReturnType<SiteSettingsService['load']>>): SiteSettingsView {
    const color = c.brandPrimaryColor && COLOR.test(c.brandPrimaryColor) ? c.brandPrimaryColor : '';
    return {
      clinicName: c.name,
      displayName: c.brandDisplayName ?? '',
      primaryColor: color,
      // La fecha en la URL rompe la caché del navegador al cambiar el logo.
      logoUrl: c.siteLogoUpdatedAt ? `/v1/public/booking/logo?v=${c.siteLogoUpdatedAt.getTime()}` : null,
      ...readContent(c.siteSettings),
    };
  }

  async get(principal: AuthPrincipal): Promise<SiteSettingsView> {
    return this.view(await this.load(clinicScope(principal).clinicId));
  }

  /** Para la página pública (sin sesión): la clínica la fija `PUBLIC_BOOKING_CLINIC_ID`. */
  async publicOf(clinicId: string): Promise<SiteSettingsView> {
    return this.view(await this.load(clinicId));
  }

  async update(principal: AuthPrincipal, dto: UpdateSiteSettingsDto, meta: RequestMeta): Promise<SiteSettingsView> {
    const { clinicId, branchId } = clinicScope(principal);
    const cur = await this.load(clinicId);
    const prev = readContent(cur.siteSettings);
    const next: SiteContent = {
      heroEyebrow: dto.heroEyebrow ?? prev.heroEyebrow,
      heroTitle: dto.heroTitle ?? prev.heroTitle,
      heroLead: dto.heroLead ?? prev.heroLead,
      phone: dto.phone ?? prev.phone,
      whatsapp: dto.whatsapp ?? prev.whatsapp,
      contactEmail: dto.contactEmail ?? prev.contactEmail,
      steps: dto.steps ?? prev.steps,
      faqs: dto.faqs ?? prev.faqs,
      privacyText: dto.privacyText ?? prev.privacyText,
      sections: dto.sections ?? prev.sections,
    };
    if (next.whatsapp && !whatsappNumber(next.whatsapp)) throw new BadRequestException('El número de WhatsApp no es válido');
    if (next.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.contactEmail)) throw new BadRequestException('El correo de contacto no es válido');
    const data: { siteSettings: object; brandDisplayName?: string | null; brandPrimaryColor?: string | null } = { siteSettings: next };
    if (dto.displayName !== undefined) data.brandDisplayName = dto.displayName || null;
    if (dto.primaryColor !== undefined) data.brandPrimaryColor = dto.primaryColor || null;
    await this.db.$transaction(async (tx) => {
      await tx.clinic.update({ where: { id: clinicId }, data });
      await this.audit.record(
        { action: 'SITE_SETTINGS_UPDATED', entity: 'Clinic', entityId: clinicId, userId: principal.user.id, clinicId, branchId, meta, summary: { fields: Object.keys(dto) } },
        tx,
      );
    });
    return this.get(principal);
  }

  async setLogo(principal: AuthPrincipal, file: UploadedFileLike | undefined, meta: RequestMeta): Promise<SiteSettingsView> {
    const { clinicId, branchId } = clinicScope(principal);
    if (!file || !file.buffer?.length) throw new BadRequestException('Adjunte la imagen del logo');
    if (file.size > LOGO_MAX_BYTES || file.buffer.length > LOGO_MAX_BYTES) throw new BadRequestException('El logo no debe pasar de 512 KB');
    const type = sniffImage(file.buffer);
    if (!type) throw new BadRequestException('El logo debe ser una imagen PNG, JPG o WebP');
    await this.db.$transaction(async (tx) => {
      await tx.clinic.update({ where: { id: clinicId }, data: { siteLogo: new Uint8Array(file.buffer), siteLogoType: type, siteLogoUpdatedAt: new Date() } });
      await this.audit.record({ action: 'SITE_LOGO_UPDATED', entity: 'Clinic', entityId: clinicId, userId: principal.user.id, clinicId, branchId, meta, summary: { type, bytes: file.buffer.length } }, tx);
    });
    return this.get(principal);
  }

  async removeLogo(principal: AuthPrincipal, meta: RequestMeta): Promise<SiteSettingsView> {
    const { clinicId, branchId } = clinicScope(principal);
    await this.db.$transaction(async (tx) => {
      await tx.clinic.update({ where: { id: clinicId }, data: { siteLogo: null, siteLogoType: null, siteLogoUpdatedAt: null } });
      await this.audit.record({ action: 'SITE_LOGO_REMOVED', entity: 'Clinic', entityId: clinicId, userId: principal.user.id, clinicId, branchId, meta }, tx);
    });
    return this.get(principal);
  }

  async logoOf(clinicId: string): Promise<{ data: Buffer; type: string } | null> {
    const c = await this.db.clinic.findUnique({ where: { id: clinicId }, select: { siteLogo: true, siteLogoType: true } });
    if (!c?.siteLogo || !c.siteLogoType) return null;
    return { data: Buffer.from(c.siteLogo), type: c.siteLogoType };
  }
}

/** Administración de la página pública. */
@Controller('site-settings')
export class SiteSettingsController {
  constructor(private readonly site: SiteSettingsService) {}

  @Get()
  @RequirePermissions('site:manage')
  get(@CurrentPrincipal() a: AuthPrincipal) {
    return this.site.get(a);
  }

  @Put()
  @RequirePermissions('site:manage')
  update(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: UpdateSiteSettingsDto, @Meta() m: RequestMeta) {
    return this.site.update(a, dto, m);
  }

  @Post('logo')
  @HttpCode(200)
  @RequirePermissions('site:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES + 1 } }))
  setLogo(@CurrentPrincipal() a: AuthPrincipal, @UploadedFile() file: UploadedFileLike | undefined, @Meta() m: RequestMeta) {
    return this.site.setLogo(a, file, m);
  }

  @Delete('logo')
  @RequirePermissions('site:manage')
  removeLogo(@CurrentPrincipal() a: AuthPrincipal, @Meta() m: RequestMeta) {
    return this.site.removeLogo(a, m);
  }
}

/** Respuesta de imagen pública del logo (la usa el controlador público de reservas). */
export function sendLogo(res: Response, logo: { data: Buffer; type: string }): StreamableFile {
  res.set({
    'Content-Type': logo.type,
    'Content-Length': String(logo.data.length),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  return new StreamableFile(logo.data);
}

@Module({
  controllers: [SiteSettingsController],
  providers: [SiteSettingsService],
  exports: [SiteSettingsService],
})
export class SiteSettingsModule {}
