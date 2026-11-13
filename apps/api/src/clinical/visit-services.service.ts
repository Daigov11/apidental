import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import { withTxRetry } from '../common/utils/tx-retry.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { ClinicalAccessService } from './clinical-access.service.js';
import { assertVisitWriter, lockVisitShared, withVisitDenial } from './clinical-visit-access.js';

/** Piezas dentarias válidas (FDI): permanentes 11-18, 21-28, 31-38, 41-48 y temporales 51-55, 61-65, 71-75, 81-85. */
const FDI = /^([1-4][1-8]|[5-8][1-5])$/;

export class AddVisitServiceDto {
  @IsUUID() productId!: string;
  /** Piezas tratadas (FDI). Vacío o ausente: el servicio no es por pieza y se usa `quantity`. */
  @IsOptional() @IsArray() @ArrayMaxSize(52) @IsString({ each: true }) @Matches(FDI, { each: true, message: 'Pieza dentaria inválida (numeración FDI)' }) teeth?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(99) quantity?: number;
}

export class SetVisitServiceQuantityDto {
  @IsInt() @Min(1) @Max(99) quantity!: number;
}

type Row = { id: string; productId: string; name: string; unitPriceCents: number; teeth: unknown; quantity: number; status: string; saleId: string | null; createdAt: Date };

export const presentVisitService = (r: Row) => ({
  id: r.id,
  productId: r.productId,
  name: r.name,
  unitPriceCents: r.unitPriceCents,
  teeth: Array.isArray(r.teeth) ? (r.teeth as string[]) : [],
  quantity: r.quantity,
  subtotalCents: r.unitPriceCents * r.quantity,
  billed: r.saleId !== null,
  createdAt: r.createdAt.toISOString(),
});

/**
 * «Servicios realizados» en una atención: el odontólogo elige un servicio del catálogo y marca las piezas tratadas (la cantidad es
 * el número de piezas). Es la cuenta del paciente: al terminar la consulta queda pendiente de pago en caja. Solo el odontólogo
 * responsable, con la visita abierta, agrega o quita servicios; uno ya cobrado no se quita.
 */
@Injectable()
export class VisitServicesService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly access: ClinicalAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthPrincipal, patientId: string, visitId: string, meta: RequestMeta) {
    const d = await this.access.authorize(actor, patientId, 'read', ['services'], meta);
    const visit = await this.db.clinicalVisit.findFirst({ where: { id: visitId, clinicId: d.clinicId, patientId }, select: { id: true } });
    if (!visit) throw new NotFoundException('Visita no encontrada');
    const rows = await this.db.visitService.findMany({ where: { visitId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    const items = rows.map(presentVisitService);
    return { items, totalCents: items.reduce((t, i) => t + i.subtotalCents, 0) };
  }

  async add(actor: AuthPrincipal, patientId: string, visitId: string, dto: AddVisitServiceDto, meta: RequestMeta) {
    const d = await this.access.authorize(actor, patientId, 'write', ['services'], meta);
    const product = await this.db.product.findFirst({ where: { id: dto.productId, clinicId: d.clinicId } });
    if (!product || product.kind !== 'SERVICE') throw new NotFoundException('Servicio del catálogo no encontrado');
    if (product.status !== 'ACTIVE') throw new ConflictException({ message: 'El servicio está inactivo en el catálogo', code: 'SERVICE_INACTIVE' });
    const teeth = [...new Set(dto.teeth ?? [])].sort();
    const quantity = teeth.length > 0 ? teeth.length : (dto.quantity ?? 1);
    if (teeth.length > 0 && dto.quantity !== undefined && dto.quantity !== teeth.length) {
      throw new BadRequestException('Con piezas marcadas, la cantidad es el número de piezas');
    }
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          const visit = await lockVisitShared(tx, visitId, d.clinicId, patientId);
          assertVisitWriter(visit, actor, d);
          if (visit.status !== 'OPEN') throw new ConflictException({ message: 'La consulta ya terminó: no se agregan servicios', code: 'VISIT_NOT_OPEN' });
          const created = await tx.visitService.create({
            data: { clinicId: d.clinicId, patientId, visitId, productId: product.id, name: product.name, unitPriceCents: product.priceCents, teeth, quantity, createdById: actor.user.id },
          });
          await this.audit.record({ action: 'VISIT_SERVICE_ADDED', entity: 'VisitService', entityId: created.id, patientId, userId: actor.user.id, clinicId: d.clinicId, branchId: d.branchId, meta, summary: { visitId, productId: product.id, quantity, unitPriceCents: product.priceCents, teethCount: teeth.length } }, tx);
          return created;
        }),
      ),
    );
    return presentVisitService(row);
  }

  /** Vista sencilla: cambia cuántas piezas (o veces) se hizo un servicio sin piezas marcadas. Con piezas, la cantidad la dan las piezas. */
  async setQuantity(actor: AuthPrincipal, patientId: string, visitId: string, serviceId: string, dto: SetVisitServiceQuantityDto, meta: RequestMeta) {
    const d = await this.access.authorize(actor, patientId, 'write', ['services'], meta);
    const row = await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          const visit = await lockVisitShared(tx, visitId, d.clinicId, patientId);
          assertVisitWriter(visit, actor, d);
          if (visit.status !== 'OPEN') throw new ConflictException({ message: 'La consulta ya terminó: no se cambian servicios', code: 'VISIT_NOT_OPEN' });
          const cur = await tx.visitService.findFirst({ where: { id: serviceId, visitId, clinicId: d.clinicId } });
          if (!cur || cur.status !== 'ACTIVE') throw new NotFoundException('Servicio no encontrado');
          if (cur.saleId) throw new ConflictException({ message: 'Ese servicio ya se cobró: no se puede cambiar', code: 'SERVICE_BILLED' });
          if (Array.isArray(cur.teeth) && cur.teeth.length > 0) {
            throw new ConflictException({ message: 'Este servicio tiene piezas marcadas: la cantidad es el número de piezas', code: 'SERVICE_HAS_TEETH' });
          }
          if (cur.quantity === dto.quantity) return cur;
          const updated = await tx.visitService.update({ where: { id: serviceId }, data: { quantity: dto.quantity } });
          await this.audit.record({ action: 'VISIT_SERVICE_QUANTITY_CHANGED', entity: 'VisitService', entityId: serviceId, patientId, userId: actor.user.id, clinicId: d.clinicId, branchId: d.branchId, meta, summary: { visitId, from: cur.quantity, to: dto.quantity } }, tx);
          return updated;
        }),
      ),
    );
    return presentVisitService(row);
  }

  async remove(actor: AuthPrincipal, patientId: string, visitId: string, serviceId: string, meta: RequestMeta) {
    const d = await this.access.authorize(actor, patientId, 'write', ['services'], meta);
    await withVisitDenial(this.access, actor, patientId, meta, () =>
      withTxRetry(() =>
        this.db.$transaction(async (tx) => {
          await this.access.assertStillAuthorized(tx, actor, d, meta);
          const visit = await lockVisitShared(tx, visitId, d.clinicId, patientId);
          assertVisitWriter(visit, actor, d);
          if (visit.status !== 'OPEN') throw new ConflictException({ message: 'La consulta ya terminó: no se quitan servicios', code: 'VISIT_NOT_OPEN' });
          const cur = await tx.visitService.findFirst({ where: { id: serviceId, visitId, clinicId: d.clinicId } });
          if (!cur || cur.status !== 'ACTIVE') throw new NotFoundException('Servicio no encontrado');
          if (cur.saleId) throw new ConflictException({ message: 'Ese servicio ya se cobró: no se puede quitar', code: 'SERVICE_BILLED' });
          await tx.visitService.update({ where: { id: serviceId }, data: { status: 'REMOVED', removedAt: new Date() } });
          await this.audit.record({ action: 'VISIT_SERVICE_REMOVED', entity: 'VisitService', entityId: serviceId, patientId, userId: actor.user.id, clinicId: d.clinicId, branchId: d.branchId, meta, summary: { visitId } }, tx);
        }),
      ),
    );
    return { ok: true };
  }
}
