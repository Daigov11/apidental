import { Body, ConflictException, Controller, Get, Inject, Injectable, Module, NotFoundException, BadRequestException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator.js';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator.js';
import { Meta, type RequestMeta } from '../common/utils/request-meta.js';
import { clinicScope, isUniqueViolation } from '../patients/patient-access.js';
import type { PrismaDb } from '../prisma/client.js';
import { PRISMA } from '../prisma/prisma.module.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value);

export class CreateProductDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) presentation?: string;
  /** Precio de venta en céntimos (IGV incluido). */
  @IsInt() @Min(1) @Max(100_000_000) priceCents!: number;
}
export class UpdateProductDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) presentation?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) priceCents?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class ListProductsQuery {
  /** «1»: incluye los inactivos (para administrar el catálogo). */
  @IsOptional() @IsString() all?: string;
}

/** Nombre comparable: sin tildes, sin mayúsculas y con un solo espacio. */
export const normalizeName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface ProductView { id: string; name: string; presentation: string | null; priceCents: number; active: boolean }
const view = (p: { id: string; name: string; presentation: string | null; priceCents: number; status: string }): ProductView => ({ id: p.id, name: p.name, presentation: p.presentation, priceCents: p.priceCents, active: p.status === 'ACTIVE' });

/** Producto del catálogo para un medicamento recetado: primero «medicamento dosis», luego solo «medicamento». */
export function matchProduct(products: ProductView[], medication: string, dose: string | null): ProductView | null {
  const full = normalizeName([medication, dose].filter(Boolean).join(' '));
  const base = normalizeName(medication);
  return products.find((p) => normalizeName(p.name) === full) ?? products.find((p) => normalizeName(p.name) === base) ?? null;
}

/** Catálogo de productos y medicamentos de la clínica, con precio de venta. Lo administra quien configura la agenda o la caja. */
@Injectable()
export class ProductsService {
  constructor(@Inject(PRISMA) private readonly db: PrismaDb, private readonly audit: AuditService) {}

  async list(principal: AuthPrincipal, all = false): Promise<ProductView[]> {
    const { clinicId } = clinicScope(principal);
    const rows = await this.db.product.findMany({ where: { clinicId, ...(all ? {} : { status: 'ACTIVE' }) }, orderBy: { name: 'asc' } });
    return rows.map(view);
  }

  async create(principal: AuthPrincipal, dto: CreateProductDto, meta: RequestMeta): Promise<ProductView> {
    const { clinicId, branchId } = clinicScope(principal);
    try {
      return await this.db.$transaction(async (tx) => {
        const row = await tx.product.create({ data: { clinicId, name: dto.name, presentation: dto.presentation || null, priceCents: dto.priceCents } });
        await this.audit.record({ action: 'PRODUCT_CREATED', entity: 'Product', entityId: row.id, userId: principal.user.id, clinicId, branchId, meta, summary: { name: row.name, priceCents: row.priceCents } }, tx);
        return view(row);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un producto con ese nombre');
      throw e;
    }
  }

  async update(principal: AuthPrincipal, id: string, dto: UpdateProductDto, meta: RequestMeta): Promise<ProductView> {
    const { clinicId, branchId } = clinicScope(principal);
    const cur = await this.db.product.findFirst({ where: { id, clinicId } });
    if (!cur) throw new NotFoundException('Producto no encontrado');
    const data: { name?: string; presentation?: string | null; priceCents?: number; status?: 'ACTIVE' | 'INACTIVE' } = {};
    if (dto.name !== undefined && dto.name !== cur.name) data.name = dto.name;
    if (dto.presentation !== undefined && (dto.presentation || null) !== cur.presentation) data.presentation = dto.presentation || null;
    if (dto.priceCents !== undefined && dto.priceCents !== cur.priceCents) data.priceCents = dto.priceCents;
    if (dto.active !== undefined && (dto.active ? 'ACTIVE' : 'INACTIVE') !== cur.status) data.status = dto.active ? 'ACTIVE' : 'INACTIVE';
    if (Object.keys(data).length === 0) throw new BadRequestException('No hay cambios');
    try {
      return await this.db.$transaction(async (tx) => {
        const row = await tx.product.update({ where: { id }, data });
        await this.audit.record({ action: 'PRODUCT_UPDATED', entity: 'Product', entityId: id, userId: principal.user.id, clinicId, branchId, meta, summary: { fields: Object.keys(data), ...(data.priceCents !== undefined ? { priceCents: { from: cur.priceCents, to: data.priceCents } } : {}) } }, tx);
        return view(row);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Ya existe un producto con ese nombre');
      throw e;
    }
  }
}

const READ = ['apiworking:sell', 'cashbox:read', 'clinical:write', 'agenda:manage', 'cashbox:manage'] as const;
const MANAGE = ['agenda:manage', 'cashbox:manage'] as const;

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequireAnyPermission(...READ)
  list(@CurrentPrincipal() a: AuthPrincipal, @Query() q: ListProductsQuery) {
    return this.products.list(a, q.all === '1');
  }

  @Post()
  @RequireAnyPermission(...MANAGE)
  create(@CurrentPrincipal() a: AuthPrincipal, @Body() dto: CreateProductDto, @Meta() m: RequestMeta) {
    return this.products.create(a, dto, m);
  }

  @Patch(':id')
  @RequireAnyPermission(...MANAGE)
  update(@CurrentPrincipal() a: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateProductDto, @Meta() m: RequestMeta) {
    return this.products.update(a, id, dto, m);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
