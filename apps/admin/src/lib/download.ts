import { getBlob } from '../api/client';

/** Descarga autenticada: pide el archivo con la sesión y lo entrega como blob (sin URL pública). */
export async function downloadFile(path: string, query: Record<string, string | number | undefined>, filename: string): Promise<void> {
  const blob = await getBlob(path, query);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
