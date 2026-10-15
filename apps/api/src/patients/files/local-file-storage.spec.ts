import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../../config/app-config.js';
import { LocalFileStorage } from './local-file-storage.js';

async function makeStorage() {
  const dir = await mkdtemp(join(tmpdir(), 'apid-storage-'));
  const config = new AppConfig({
    DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db',
    JWT_ACCESS_SECRET: 's'.repeat(48),
    ATTACHMENTS_DIR: dir,
  });
  const storage = new LocalFileStorage(config);
  await storage.onModuleInit();
  return { storage, dir };
}

describe('LocalFileStorage', () => {
  it('guarda con nombre UUID, permisos restrictivos y recupera el contenido', async () => {
    const { storage, dir } = await makeStorage();
    const key = storage.newKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    await storage.put(key, Buffer.from('contenido'));
    expect((await readFile(join(dir, key.slice(0, 2), key))).toString()).toBe('contenido');
    expect((await storage.get(key)).toString()).toBe('contenido');
    expect((await stat(join(dir, key.slice(0, 2), key))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('nunca sobrescribe un archivo existente', async () => {
    const { storage } = await makeStorage();
    const key = storage.newKey();
    await storage.put(key, Buffer.from('original'));
    await expect(storage.put(key, Buffer.from('otro'))).rejects.toThrow();
    expect((await storage.get(key)).toString()).toBe('original');
  });

  it('rechaza claves que no sean UUID (sin recorrido de directorios)', async () => {
    const { storage } = await makeStorage();
    for (const bad of ['../../etc/passwd', 'a/b', '..', '', 'not-a-uuid', '/etc/passwd']) {
      await expect(storage.get(bad)).rejects.toThrow();
      await expect(storage.put(bad, Buffer.from('x'))).rejects.toThrow();
    }
  });

  it('NO expone ninguna operación de borrado', async () => {
    const { storage } = await makeStorage();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(storage));
    expect(methods.filter((m) => /delete|remove|unlink|rm|destroy/i.test(m))).toEqual([]);
    const key = storage.newKey();
    await storage.put(key, Buffer.from('x'));
    expect(await readdir(join((storage as unknown as { root: string }).root, key.slice(0, 2)))).toContain(key);
  });
});
