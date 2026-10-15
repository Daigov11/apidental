export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Política mínima de contraseñas para las que ELIGE la persona (alta por invitación y recuperación):
 * longitud 12-128, distinta de su correo y con variedad mínima de caracteres. Es una política mínima:
 * no sustituye una lista de contraseñas filtradas ni un medidor de fortaleza **[por validar]**.
 * Devuelve la lista de problemas (vacía si es válida).
 */
export function passwordPolicyErrors(password: string, context: { email?: string } = {}): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (password.length > PASSWORD_MAX_LENGTH) errors.push(`La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres`);
  if (new Set(password).size < 4) errors.push('La contraseña es demasiado repetitiva: use más variedad de caracteres');
  if (context.email && password.toLowerCase() === context.email.trim().toLowerCase()) {
    errors.push('La contraseña no puede ser igual a su correo');
  }
  return errors;
}
