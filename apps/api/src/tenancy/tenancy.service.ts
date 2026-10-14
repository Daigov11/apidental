import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/utils/request-meta.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';
import type { CreateBranchDto, ListBranchesQuery } from './dto/branch.dto.js';
import type { CreateClinicDto } from './dto/clinic.dto.js';

const CLINIC_SELECT = {
  id: true,
  name: true,
  legalName: true,
  ruc: true,
  brandDisplayName: true,
  brandLogoUrl: true,
  brandPrimaryColor: true,
  brandSecondaryColor: true,
  status: true,
  createdAt: true,
} as const;

const BRANCH_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  address: true,
  status: true,
  createdAt: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class TenancyService {
  constructor(
    @Inject(PRISMA) private readonly db: PrismaDb,
    private readonly audit: AuditService,
  ) {}

  /** Plataforma: todas las clínicas. Resto: únicamente la clínica del contexto activo. */
  listClinics(principal: AuthPrincipal, limit: number, offset: number) {
    const clinicId = principal.context?.clinicId ?? null;
    return this.db.clinic.findMany({
      where: clinicId ? { id: clinicId } : {},
      select: CLINIC_SELECT,
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  async createClinic(principal: AuthPrincipal, dto: CreateClinicDto, meta: RequestMeta) {
    try {
      return await this.db.$transaction(async (tx) => {
        const clinic = await tx.clinic.create({ data: dto, select: CLINIC_SELECT });
        await this.audit.record(
          {
            action: AuditAction.ClinicCreated,
            entity: 'Clinic',
            entityId: clinic.id,
            userId: principal.user.id,
            clinicId: clinic.id,
            meta,
            summary: { name: clinic.name, ruc: clinic.ruc },
          },
          tx,
        );
        return clinic;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe una clínica con ese RUC');
      throw error;
    }
  }

  /** Plataforma: todas (filtrable por clínica). Resto: su clínica, y solo su sede si el contexto la fija. */
  listBranches(principal: AuthPrincipal, query: ListBranchesQuery) {
    const ctx = principal.context!;
    const where =
      ctx.clinicId === null
        ? query.clinicId
          ? { clinicId: query.clinicId }
          : {}
        : { clinicId: ctx.clinicId, ...(ctx.branchId ? { id: ctx.branchId } : {}) };
    return this.db.branch.findMany({
      where,
      select: BRANCH_SELECT,
      orderBy: [{ clinicId: 'asc' }, { name: 'asc' }],
      take: query.limit,
      skip: query.offset,
    });
  }

  async createBranch(principal: AuthPrincipal, dto: CreateBranchDto, meta: RequestMeta) {
    const ctx = principal.context!;
    if (ctx.clinicId !== null && ctx.branchId !== null) {
      throw new ForbiddenException('Un contexto limitado a una sede no puede crear sedes');
    }
    if (ctx.clinicId !== null && dto.clinicId && dto.clinicId !== ctx.clinicId) {
      throw new ForbiddenException('No puede crear sedes en otra clínica');
    }
    const clinicId = ctx.clinicId ?? dto.clinicId;
    if (!clinicId) throw new BadRequestException('Indique clinicId para crear la sede');

    const clinic = await this.db.clinic.findUnique({ where: { id: clinicId }, select: { id: true, status: true } });
    if (!clinic || clinic.status !== 'ACTIVE') throw new NotFoundException('Clínica no encontrada');

    try {
      return await this.db.$transaction(async (tx) => {
        const branch = await tx.branch.create({
          data: { clinicId, name: dto.name, address: dto.address },
          select: BRANCH_SELECT,
        });
        await this.audit.record(
          {
            action: AuditAction.BranchCreated,
            entity: 'Branch',
            entityId: branch.id,
            userId: principal.user.id,
            clinicId,
            branchId: branch.id,
            meta,
            summary: { name: branch.name },
          },
          tx,
        );
        return branch;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe una sede con ese nombre en la clínica');
      throw error;
    }
  }
}
