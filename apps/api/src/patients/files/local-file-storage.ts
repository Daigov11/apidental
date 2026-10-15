import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Almacenamiento en disco PRIVADO. Reglas de diseño:
 *  - El nombre en disco es un UUID aleatorio; el nombre original solo existe en la BD.
 *  - Permisos 0700/0600 y creación exclusiva (`wx`): nunca sobrescribe.
 *  - NO existe método de borrado: los archivos no se eliminan físicamente (solo baja lógica en BD).
 *  - La clave jamás sale por la API; el acceso es solo mediante endpoints autorizados.
 */
@Injectable()
export class LocalFileStorage implements OnModuleInit {
  private readonly root: string;

  constructor(config: AppConfig) {
    this.root = config.attachments.dir;
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  newKey(): string {
    return randomUUID();
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Clave de almacenamiento inválida');
    const path = resolve(this.root, key.slice(0, 2), key);
    if (!path.startsWith(this.root + sep)) throw new Error('Ruta fuera del almacenamiento');
    return path;
  }
}
