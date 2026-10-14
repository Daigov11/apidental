/** Clave única de una asignación; resuelve la unicidad con columnas NULL (clínica/sede). */
export const assignmentKey = (
  userId: string,
  g: { roleId: string; clinicId: string | null; branchId: string | null },
): string => [userId, g.roleId, g.clinicId ?? '*', g.branchId ?? '*'].join('|');
