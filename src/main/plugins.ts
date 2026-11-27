// Plugins: carpetas con un manifest.json y un archivo JavaScript que la interfaz ejecuta en un
// Web Worker aislado (sin acceso a Node, a la red ni a la página), con una API limitada.
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PluginInfo, PluginManifest, PluginPermission, Settings } from '../shared/types';

export const PERMISSIONS: Record<PluginPermission, string> = {
  'terminal:read': 'Leer lo que aparece en los terminales',
  'terminal:write': 'Escribir en el terminal activo (como si tecleases)',
  'sessions:read': 'Ver la lista de sesiones guardadas (nombre, tipo y host; nunca contraseñas)',
};

const MAX_CODE = 2 * 1024 * 1024;

export function validateManifest(raw: unknown, dirName?: string): PluginManifest {
  const m = raw as Partial<PluginManifest>;
  if (!m || typeof m !== 'object') throw new Error('manifest.json no es un objeto.');
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,59}$/.test(m.id)) throw new Error('«id» debe tener de 2 a 60 caracteres: minúsculas, números, punto, guion o guion bajo.');
  if (dirName && dirName !== m.id) throw new Error(`La carpeta se llama «${dirName}» pero el id es «${m.id}»: deben coincidir.`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('Falta «name».');
  if (typeof m.version !== 'string' || !/^\d+\.\d+(\.\d+)?([-+][\w.]+)?$/.test(m.version)) throw new Error('«version» debe ser del tipo 1.0.0.');
  const main = m.main ?? 'main.js';
  if (typeof main !== 'string' || !/^[\w./-]+\.m?js$/.test(main) || main.includes('..') || main.startsWith('/')) throw new Error('«main» debe ser un archivo .js dentro de la carpeta del plugin.');
  const perms = m.permissions ?? [];
  if (!Array.isArray(perms)) throw new Error('«permissions» debe ser una lista.');
  for (const p of perms) if (!(p in PERMISSIONS)) throw new Error(`Permiso desconocido: «${p}». Válidos: ${Object.keys(PERMISSIONS).join(', ')}.`);
  return {
    id: m.id,
    name: m.name.trim().slice(0, 60),
    version: m.version,
    description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined,
    author: typeof m.author === 'string' ? m.author.slice(0, 100) : undefined,
    main,
    permissions: [...new Set(perms)],
  };
}

export class PluginManager {
  constructor(readonly dir: string, private readonly dataDir: string) {}

  private async readManifest(pluginDir: string, dirName?: string): Promise<PluginManifest> {
    const text = await fs.readFile(join(pluginDir, 'manifest.json'), 'utf8').catch(() => {
      throw new Error('No hay manifest.json.');
    });
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw new Error('manifest.json no es JSON válido.');
    }
    return validateManifest(raw, dirName);
  }

  async list(settings: Pick<Settings, 'plugins'>): Promise<PluginInfo[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    const out: PluginInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = join(this.dir, e.name);
      const granted = settings.plugins[e.name];
      try {
        const manifest = await this.readManifest(dir, e.name);
        const needsApproval = !!granted && (manifest.permissions || []).some((p) => !granted.permissions.includes(p));
        out.push({ id: manifest.id, dir, manifest, enabled: !!granted, needsApproval });
      } catch (err) {
        out.push({ id: e.name, dir, error: (err as Error).message, enabled: !!granted, needsApproval: false });
      }
    }
    return out.sort((a, b) => (a.manifest?.name || a.id).localeCompare(b.manifest?.name || b.id));
  }

  /** Código del plugin (sólo si está activado y con todos sus permisos aceptados). */
  async code(id: string, settings: Pick<Settings, 'plugins'>): Promise<{ manifest: PluginManifest; code: string }> {
    const granted = settings.plugins[id];
    if (!granted) throw new Error('El plugin no está activado.');
    const dir = this.pluginDir(id);
    const manifest = await this.readManifest(dir, id);
    if ((manifest.permissions || []).some((p) => !granted.permissions.includes(p))) throw new Error('El plugin pide permisos nuevos: vuelve a activarlo.');
    const file = resolve(dir, manifest.main || 'main.js');
    if (!file.startsWith(dir + sep)) throw new Error('Ruta de «main» no válida.');
    const st = await fs.stat(file).catch(() => null);
    if (!st) throw new Error(`No existe ${manifest.main}.`);
    if (st.size > MAX_CODE) throw new Error('El código del plugin supera 2 MB.');
    return { manifest, code: await fs.readFile(file, 'utf8') };
  }

  private pluginDir(id: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{1,59}$/.test(id)) throw new Error('Id de plugin no válido.');
    return join(this.dir, id);
  }

  /** Instala (o actualiza) un plugin copiando su carpeta. */
  async install(srcDir: string): Promise<PluginManifest> {
    const manifest = await this.readManifest(srcDir);
    const dest = this.pluginDir(manifest.id);
    if (resolve(srcDir) === resolve(dest)) return manifest;
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(srcDir, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
    return manifest;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.pluginDir(id), { recursive: true, force: true });
    await fs.rm(this.storageFile(id), { force: true });
  }

  // Almacenamiento propio de cada plugin (fuera de su carpeta, para que sobreviva a las actualizaciones).
  private storageFile(id: string): string {
    this.pluginDir(id);
    return join(this.dataDir, `${id}.json`);
  }

  async storageGet(id: string, key: string): Promise<unknown> {
    const data = JSON.parse(await fs.readFile(this.storageFile(id), 'utf8').catch(() => '{}'));
    return data[key] ?? null;
  }

  async storageSet(id: string, key: string, value: unknown): Promise<void> {
    if (typeof key !== 'string' || key.length > 200) throw new Error('Clave no válida.');
    const f = this.storageFile(id);
    const data = JSON.parse(await fs.readFile(f, 'utf8').catch(() => '{}'));
    if (value === null || value === undefined) delete data[key];
    else data[key] = value;
    const text = JSON.stringify(data);
    if (text.length > 1024 * 1024) throw new Error('El almacenamiento del plugin supera 1 MB.');
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(f, text);
  }
}
