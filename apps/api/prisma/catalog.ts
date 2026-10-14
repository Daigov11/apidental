import { PERMISSIONS, ROLE_DEFINITIONS } from '../src/auth/permissions.js';
import type { PrismaDb } from '../src/prisma/client.js';

/** Sincroniza permisos, roles y role_permissions con el catálogo en código (idempotente). */
export async function syncCatalog(db: PrismaDb): Promise<{ permissions: number; roles: number }> {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await db.permission.upsert({ where: { code }, update: { description }, create: { code, description } });
  }
  const permissions = await db.permission.findMany();
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const def of ROLE_DEFINITIONS) {
    const role = await db.role.upsert({
      where: { code: def.code },
      update: { name: def.name, scope: def.scope, description: def.description },
      create: { code: def.code, name: def.name, scope: def.scope, description: def.description },
    });
    const wanted = def.permissions.map((c) => idByCode.get(c)!);
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wanted } } });
    for (const permissionId of wanted) {
      await db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }
  return { permissions: permissions.length, roles: ROLE_DEFINITIONS.length };
}
