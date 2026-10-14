/**
 * Carga el .env de la raíz del monorepo (solo desarrollo y pruebas).
 * Nunca pisa variables ya definidas en el entorno del proceso.
 */
export function loadEnvFile(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  for (const file of ['../../.env', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // archivo inexistente: se continúa con el entorno actual
    }
  }
}
