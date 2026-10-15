import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { RemoveAttachmentDto, UploadAttachmentDto } from './dto/attachment.dto.js';
import { sanitizeFileName, sniffMime } from './files/file-sniff.js';
import { LocalFileStorage } from './files/local-file-storage.js';
import { clinicScope, requirePatient } from './patient-access.js';

/** Archivo recibido por multer (almacenamiento en memoria). */
export interface UploadedFileLike {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

type AttachmentRow = {
  id: string;
  consentId: string | null;
  category: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  description: string | null;
  status: string;
  removedAt: Date | null;
  removalReason: string | null;
  createdAt: Date;
};

/**
 * Vista de un adjunto para quien tiene attachment:read. NUNCA incluye storageKey ni rutas:
 * el archivo solo se obtiene por el endpoint de descarga autorizado.
 */
export function toAttachmentView(a: AttachmentRow) {
  return {
    id: a.id,
    consentId: a.consentId,
    category: a.category,
    originalName: a.originalName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    description: a.description,
    status: a.status,
    removedAt: a.removedAt,
    removalReason: a.removalReason,
    uploadedAt: a.createdAt,
  };
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
    private readonly storage: LocalFileStorage,
    private readonly config: AppConfig,
  ) {}

  async upload(
    actor: AuthPrincipal,
    patientId: string,
    file: UploadedFileLike | undefined,
    dto: UploadAttachmentDto,
    meta: RequestMeta,
  ) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId, { active: true });

    if (!file) throw new BadRequestException('Falta el archivo (campo "file")');
    const data = file.buffer;
    if (!data || data.length === 0) throw new UnprocessableEntityException('El archivo está vacío');
    if (data.length > this.config.attachments.maxBytes) {
      throw new UnprocessableEntityException(`El archivo supera el máximo de ${this.config.attachments.maxBytes} bytes`);
    }

    // El tipo se decide por el CONTENIDO; el declarado por el cliente debe coincidir.
    const detected = sniffMime(data);
    if (!detected) throw new UnsupportedMediaTypeException('Tipo de archivo no permitido (solo PDF, JPEG, PNG o WebP)');
    if (file.mimetype !== detected) {
      throw new UnsupportedMediaTypeException('El tipo declarado no coincide con el contenido del archivo');
    }

    if (dto.consentId) {
      if (dto.category !== 'CONSENT') {
        throw new BadRequestException('consentId solo aplica a la categoría CONSENT');
      }
      const consent = await this.db.patientConsent.findFirst({
        where: { id: dto.consentId, patientId, clinicId },
        select: { id: true },
      });
      if (!consent) throw new NotFoundException('Consentimiento no encontrado para este paciente');
    }

    const sha256 = createHash('sha256').update(data).digest('hex');
    const duplicate = await this.db.attachment.findFirst({
      where: { clinicId, patientId, sha256, category: dto.category, status: 'ACTIVE' },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException({ message: 'Ya existe un archivo idéntico cargado para este paciente', code: 'DUPLICATE_FILE' });
    }

    const storageKey = this.storage.newKey();
    const id = await this.db.$transaction(async (tx) => {
      const row = await tx.attachment.create({
        data: {
          clinicId,
          patientId,
          consentId: dto.consentId ?? null,
          category: dto.category,
          originalName: sanitizeFileName(file.originalname ?? ''),
          mimeType: detected,
          sizeBytes: data.length,
          sha256,
          storageKey,
          description: dto.description ?? null,
          uploadedById: actor.user.id,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.AttachmentUploaded,
          entity: 'Attachment',
          entityId: row.id,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: {
            category: dto.category,
            mimeType: detected,
            sizeBytes: data.length,
            sha256,
            consentId: dto.consentId ?? null,
          },
        },
        tx,
      );
      // El archivo se escribe al final: si falla, la transacción se revierte y no queda registro huérfano.
      await this.storage.put(storageKey, data);
      return row.id;
    });
    return toAttachmentView(await this.db.attachment.findUniqueOrThrow({ where: { id } }));
  }

  async list(actor: AuthPrincipal, patientId: string, includeRemoved: boolean, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const rows = await this.db.attachment.findMany({
      where: { patientId, clinicId, ...(includeRemoved ? {} : { status: 'ACTIVE' }) },
      orderBy: { createdAt: 'desc' },
    });
    await this.audit.record({
      action: AuditAction.AttachmentListed,
      entity: 'Patient',
      entityId: patientId,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { count: rows.length, includeRemoved },
    });
    return rows.map(toAttachmentView);
  }

  async download(actor: AuthPrincipal, patientId: string, attachmentId: string, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const attachment = await this.db.attachment.findFirst({ where: { id: attachmentId, patientId, clinicId } });
    if (!attachment) throw new NotFoundException('Adjunto no encontrado');
    if (attachment.status === 'REMOVED') throw new NotFoundException('Adjunto no encontrado');

    // La descarga es un acceso a datos personales: se audita ANTES de entregar el archivo.
    await this.audit.record({
      action: AuditAction.AttachmentDownloaded,
      entity: 'Attachment',
      entityId: attachment.id,
      patientId,
      userId: actor.user.id,
      clinicId,
      branchId,
      meta,
      summary: { category: attachment.category, sizeBytes: attachment.sizeBytes },
    });

    let data: Buffer;
    try {
      data = await this.storage.get(attachment.storageKey);
    } catch (error) {
      this.logger.error({ msg: 'Archivo de adjunto no disponible en disco', attachmentId, error: String(error) });
      throw new InternalServerErrorException('El archivo no está disponible');
    }
    // Verificación de integridad contra el hash registrado al cargar.
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== attachment.sha256) {
      this.logger.error({ msg: 'Hash de adjunto no coincide: posible alteración', attachmentId });
      throw new InternalServerErrorException('El archivo no superó la verificación de integridad');
    }
    return { data, mimeType: attachment.mimeType, fileName: attachment.originalName };
  }

  /** Baja lógica: el registro y el archivo en disco permanecen; solo deja de estar disponible. */
  async remove(actor: AuthPrincipal, patientId: string, attachmentId: string, dto: RemoveAttachmentDto, meta: RequestMeta) {
    const { clinicId, branchId } = clinicScope(actor);
    await requirePatient(this.db, clinicId, patientId);
    const attachment = await this.db.attachment.findFirst({ where: { id: attachmentId, patientId, clinicId } });
    if (!attachment) throw new NotFoundException('Adjunto no encontrado');
    if (attachment.status === 'REMOVED') throw new ConflictException('El adjunto ya fue dado de baja');

    await this.db.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id: attachmentId },
        data: { status: 'REMOVED', removedAt: new Date(), removedById: actor.user.id, removalReason: dto.reason },
      });
      await this.audit.record(
        {
          action: AuditAction.AttachmentRemoved,
          entity: 'Attachment',
          entityId: attachmentId,
          patientId,
          userId: actor.user.id,
          clinicId,
          branchId,
          meta,
          summary: { category: attachment.category, reason: dto.reason, physicalFileKept: true },
        },
        tx,
      );
    });
    return toAttachmentView(await this.db.attachment.findUniqueOrThrow({ where: { id: attachmentId } }));
  }
}
