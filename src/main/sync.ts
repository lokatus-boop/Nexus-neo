// Sincronización cifrada de sesiones, macros y plantillas entre equipos.
//
// Todos los equipos comparten un único archivo cifrado (nexus-neo-sync.json) en una carpeta
// sincronizada (Dropbox, OneDrive, Syncthing, una unidad de red…) o en un servidor SFTP. El
// archivo se cifra con una frase de sincronización (scrypt + AES-256-GCM): el proveedor de la
// nube sólo ve datos opacos. Cada elemento lleva su fecha de modificación y los borrados dejan
// una marca, así que la fusión es determinista: gana la versión más reciente y un borrado
// posterior elimina el elemento en todos los equipos.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { SecretEntry } from '../shared/types';

export const SYNC_FILE = 'nexus-neo-sync.json';
const KDF = { N: 1 << 15, r: 8, p: 1 };

export interface SyncItem {
  id: string;
  updatedAt?: number;
}

/** Contenido descifrado del archivo de sincronización. */
export interface SyncBundle {
  version: 1;
  /** Colecciones sincronizadas: sessions, macros, templates… */
  collections: Record<string, SyncItem[]>;
  /** "colección:id" → fecha de borrado. */
  deleted: Record<string, number>;
  /** Secretos de la bóveda por id de sesión, con su fecha. Sólo si se activa. */
  secrets: Record<string, SecretEntry & { updatedAt: number }>;
  /** Equipo → última sincronización. */
  devices: Record<string, number>;
  updatedAt: number;
}

interface SyncFile {
  format: 'nexus-neo-sync';
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

export function emptyBundle(): SyncBundle {
  return { version: 1, collections: {}, deleted: {}, secrets: {}, devices: {}, updatedAt: 0 };
}

// --- Cifrado ------------------------------------------------------------------

export function encryptBundle(bundle: SyncBundle, passphrase: string): string {
  if (passphrase.length < 8) throw new Error('La frase de sincronización debe tener al menos 8 caracteres.');
  const salt = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, 32, { ...KDF, maxmem: 128 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('nexus-neo-sync/1'));
  const data = Buffer.concat([c.update(JSON.stringify(bundle), 'utf8'), c.final()]);
  const out: SyncFile = {
    format: 'nexus-neo-sync',
    version: 1,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(out);
}

export function decryptBundle(text: string, passphrase: string): SyncBundle {
  let raw: SyncFile;
  try {
    raw = JSON.parse(text) as SyncFile;
  } catch {
    throw new Error('El archivo de sincronización está dañado.');
  }
  if (raw.format !== 'nexus-neo-sync' || raw.version !== 1 || raw.kdf?.name !== 'scrypt') throw new Error('No es un archivo de sincronización de Nexus Neo.');
  const key = scryptSync(passphrase.normalize('NFKC'), Buffer.from(raw.kdf.salt, 'base64'), 32, { N: raw.kdf.N, r: raw.kdf.r, p: raw.kdf.p, maxmem: 128 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
  d.setAAD(Buffer.from('nexus-neo-sync/1'));
  d.setAuthTag(Buffer.from(raw.tag, 'base64'));
  try {
    const json = Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]).toString('utf8');
    return { ...emptyBundle(), ...(JSON.parse(json) as SyncBundle) };
  } catch {
    throw new Error('Frase de sincronización incorrecta o archivo manipulado.');
  }
}

// --- Fusión -------------------------------------------------------------------

export interface MergeStats {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Fusiona una colección: gana la versión con fecha más reciente; si hay una marca de borrado
 * igual o posterior a esa versión, el elemento se elimina. Devuelve también qué cambia en local.
 */
export function mergeCollection<T extends SyncItem>(
  name: string,
  local: T[],
  remote: T[],
  deleted: Record<string, number>,
): { items: T[]; stats: MergeStats } {
  const stats: MergeStats = { added: 0, updated: 0, removed: 0 };
  const byId = new Map<string, { local?: T; remote?: T }>();
  for (const l of local) byId.set(l.id, { local: l });
  for (const r of remote) byId.set(r.id, { ...byId.get(r.id), remote: r });
  const items: T[] = [];
  // Conserva el orden local y añade al final lo nuevo.
  const order = [...local.map((x) => x.id), ...remote.map((x) => x.id).filter((id) => !local.some((l) => l.id === id))];
  for (const id of order) {
    const { local: l, remote: r } = byId.get(id)!;
    const lt = l?.updatedAt ?? 0;
    const rt = r?.updatedAt ?? 0;
    const winner = !l ? r! : !r ? l : rt > lt ? r : l;
    const del = deleted[`${name}:${id}`];
    if (del !== undefined && del >= (winner.updatedAt ?? 0)) {
      if (l) stats.removed++;
      continue;
    }
    if (!l) stats.added++;
    else if (winner === r && JSON.stringify(l) !== JSON.stringify(r)) stats.updated++;
    items.push(winner);
  }
  return { items, stats };
}

export function mergeDeleted(a: Record<string, number>, b: Record<string, number>, maxAgeDays = 180): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  // Las marcas muy antiguas se olvidan para que el archivo no crezca sin límite.
  const limit = Date.now() - maxAgeDays * 86_400_000;
  for (const [k, v] of Object.entries(out)) if (v < limit) delete out[k];
  return out;
}

export interface LocalState {
  collections: Record<string, SyncItem[]>;
  deleted: Record<string, number>;
  /** Secretos locales por id de sesión (sólo si se sincronizan), con la fecha de su sesión. */
  secrets?: Record<string, SecretEntry & { updatedAt: number }>;
}

/** Fusiona el estado local con el remoto. El resultado se guarda en ambos lados. */
export function mergeState(local: LocalState, remote: SyncBundle, device: string, now = Date.now()): { bundle: SyncBundle; stats: MergeStats } {
  const deleted = mergeDeleted(local.deleted, remote.deleted);
  const stats: MergeStats = { added: 0, updated: 0, removed: 0 };
  const collections: Record<string, SyncItem[]> = {};
  for (const name of new Set([...Object.keys(local.collections), ...Object.keys(remote.collections)])) {
    const r = mergeCollection(name, local.collections[name] || [], remote.collections[name] || [], deleted);
    collections[name] = r.items;
    stats.added += r.stats.added;
    stats.updated += r.stats.updated;
    stats.removed += r.stats.removed;
  }
  const secrets: SyncBundle['secrets'] = {};
  if (local.secrets) {
    const live = new Set((collections.sessions || []).map((s) => s.id));
    for (const id of new Set([...Object.keys(local.secrets), ...Object.keys(remote.secrets || {})])) {
      if (!live.has(id)) continue;
      const l = local.secrets[id];
      const r = remote.secrets?.[id];
      const w = !l ? r : !r ? l : r.updatedAt > l.updatedAt ? r : l;
      if (w) secrets[id] = w;
    }
  }
  return {
    bundle: { version: 1, collections, deleted, secrets, devices: { ...remote.devices, [device]: now }, updatedAt: now },
    stats,
  };
}

// --- Almacenamiento remoto ---------------------------------------------------------

export interface SyncTarget {
  describe(): string;
  /** Devuelve el contenido del archivo o null si todavía no existe. */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** Archivo dentro de una carpeta sincronizada por otro programa (o una unidad de red). */
export class FolderTarget implements SyncTarget {
  constructor(private readonly dir: string) {}

  describe(): string {
    return join(this.dir, SYNC_FILE);
  }

  async read(): Promise<string | null> {
    try {
      return await fs.readFile(join(this.dir, SYNC_FILE), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = join(this.dir, SYNC_FILE);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
}

/** Archivo en un servidor SFTP (por ejemplo, el propio servidor de salto de la empresa). */
export class SftpTarget implements SyncTarget {
  constructor(private readonly sftp: () => Promise<SFTPWrapper>, private readonly path: string, private readonly label: string) {}

  describe(): string {
    return `${this.label}:${this.path}`;
  }

  private file(): string {
    return this.path.endsWith('.json') ? this.path : `${this.path.replace(/\/+$/, '')}/${SYNC_FILE}`;
  }

  async read(): Promise<string | null> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.readFile(this.file(), 'utf8', (err, data) => {
        if (err) return (err as { code?: number }).code === 2 ? resolve(null) : reject(err);
        resolve(String(data));
      });
    });
  }

  async write(text: string): Promise<void> {
    const s = await this.sftp();
    const file = this.file();
    const dir = dirname(file);
    await new Promise<void>((resolve) => s.mkdir(dir, () => resolve()));
    const tmp = `${file}.tmp`;
    await new Promise<void>((resolve, reject) => s.writeFile(tmp, text, { mode: 0o600 }, (e) => (e ? reject(e) : resolve())));
    await new Promise<void>((resolve, reject) => s.unlink(file, () => s.rename(tmp, file, (e) => (e ? reject(e) : resolve()))));
  }
}

/** Ejecuta una sincronización completa: leer, fusionar, escribir. */
export async function syncOnce(
  target: SyncTarget,
  passphrase: string,
  local: LocalState,
  device: string,
): Promise<{ bundle: SyncBundle; stats: MergeStats; created: boolean }> {
  const text = await target.read();
  const remote = text ? decryptBundle(text, passphrase) : emptyBundle();
  const { bundle, stats } = mergeState(local, remote, device);
  await target.write(encryptBundle(bundle, passphrase));
  return { bundle, stats, created: !text };
}
