// Persistencia en JSON dentro del directorio de datos de la app.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigTemplate, Macro, ServerConfig, SessionConfig, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'nexus-dark',
  fontFamily: '"JetBrains Mono", "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace',
  fontSize: 14,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  confirmOnClose: true,
  defaultLocalShell: '',
  rdpClient: '',
  vncClient: '',
  vaultAutoLockMin: 30,
  logAllSessions: false,
  logDir: '',
  logStripAnsi: true,
  autoReconnect: true,
  disclaimerAccepted: 0,
  sync: { enabled: false, mode: 'folder', path: '', includeSecrets: false, intervalMin: 15, deviceName: '' },
  backupSchedule: { enabled: false, everyHours: 24, devices: [] },
};

class JsonFile<T> {
  private cache: T | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly fallback: () => T) {}

  async read(): Promise<T> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.path, 'utf8')) as T;
    } catch {
      this.cache = this.fallback();
    }
    return this.cache;
  }

  async write(value: T): Promise<void> {
    this.cache = value;
    // Serializa escrituras y usa archivo temporal para no corromper datos.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.path);
    });
    return this.writing;
  }
}

export class Store {
  private sessions: JsonFile<SessionConfig[]>;
  private macros: JsonFile<Macro[]>;
  private templates: JsonFile<ConfigTemplate[]>;
  private settings: JsonFile<Partial<Settings>>;
  private known: JsonFile<Record<string, string>>;
  private servers: JsonFile<ServerConfig[] | null>;
  private knownCache: Record<string, string> = {};
  private deleted: JsonFile<Record<string, number>>;
  /** Se llama tras cualquier cambio en datos sincronizables (sesiones, macros, plantillas…). */
  onChange: (() => void) | null = null;

  constructor(readonly dir: string) {
    this.sessions = new JsonFile(join(dir, 'sessions.json'), () => []);
    this.macros = new JsonFile(join(dir, 'macros.json'), () => []);
    this.templates = new JsonFile(join(dir, 'templates.json'), () => []);
    this.settings = new JsonFile(join(dir, 'settings.json'), () => ({}));
    this.known = new JsonFile(join(dir, 'known_hosts.json'), () => ({}));
    this.servers = new JsonFile(join(dir, 'servers.json'), () => null);
    this.deleted = new JsonFile(join(dir, 'deleted.json'), () => ({}));
  }

  private changed(): void {
    this.onChange?.();
  }

  /** Marcas de borrado para la sincronización: "colección:id" → fecha. */
  async tombstones(): Promise<Record<string, number>> {
    return { ...(await this.deleted.read()) };
  }

  async setTombstones(t: Record<string, number>): Promise<void> {
    await this.deleted.write(t);
  }

  private async markDeleted(collection: string, id: string): Promise<void> {
    const t = await this.deleted.read();
    await this.deleted.write({ ...t, [`${collection}:${id}`]: Date.now() });
  }

  /** Sustituye la lista completa (lo usa la sincronización tras fusionar). */
  async replaceSessions(list: SessionConfig[]): Promise<void> {
    await this.sessions.write(list);
  }

  async replaceMacros(list: Macro[]): Promise<void> {
    await this.macros.write(list);
  }

  async replaceTemplates(list: ConfigTemplate[]): Promise<void> {
    await this.templates.write(list);
  }

  listTemplates(): Promise<ConfigTemplate[]> {
    return this.templates.read();
  }

  async saveTemplate(t: ConfigTemplate): Promise<ConfigTemplate> {
    const list = [...(await this.templates.read())];
    const clean = { ...t, id: t.id || randomUUID(), updatedAt: Date.now() };
    const i = list.findIndex((x) => x.id === clean.id);
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    await this.templates.write(list);
    this.changed();
    return clean;
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.templates.write((await this.templates.read()).filter((t) => t.id !== id));
    await this.markDeleted('templates', id);
    this.changed();
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.knownCache = await this.known.read();
  }

  listSessions(): Promise<SessionConfig[]> {
    return this.sessions.read();
  }

  async getSession(id: string): Promise<SessionConfig | undefined> {
    return (await this.sessions.read()).find((s) => s.id === id);
  }

  async saveSession(s: SessionConfig): Promise<SessionConfig> {
    const list = [...(await this.sessions.read())];
    const clean: SessionConfig = { ...s, id: s.id || randomUUID(), name: s.name?.trim() || s.host || 'Sesión', updatedAt: Date.now() };
    const i = list.findIndex((x) => x.id === clean.id);
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    await this.sessions.write(list);
    this.changed();
    return clean;
  }

  async addSessions(items: SessionConfig[]): Promise<void> {
    const now = Date.now();
    const list = [...(await this.sessions.read()), ...items.map((s) => ({ ...s, updatedAt: now }))];
    await this.sessions.write(list);
    this.changed();
  }

  async deleteSession(id: string): Promise<void> {
    const list = (await this.sessions.read()).filter((s) => s.id !== id);
    await this.sessions.write(list);
    await this.markDeleted('sessions', id);
    this.changed();
  }

  listMacros(): Promise<Macro[]> {
    return this.macros.read();
  }

  async saveMacro(m: Macro): Promise<Macro> {
    const list = [...(await this.macros.read())];
    const clean = { ...m, id: m.id || randomUUID(), updatedAt: Date.now() };
    const i = list.findIndex((x) => x.id === clean.id);
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    await this.macros.write(list);
    this.changed();
    return clean;
  }

  async deleteMacro(id: string): Promise<void> {
    await this.macros.write((await this.macros.read()).filter((m) => m.id !== id));
    await this.markDeleted('macros', id);
    this.changed();
  }

  async getSettings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await this.settings.read()) };
  }

  async saveSettings(s: Partial<Settings>): Promise<Settings> {
    const merged = { ...(await this.getSettings()), ...s };
    await this.settings.write(merged);
    return merged;
  }

  /** Devuelve los servidores guardados o null si nunca se han configurado. */
  listServers(): Promise<ServerConfig[] | null> {
    return this.servers.read();
  }

  async saveServers(list: ServerConfig[]): Promise<void> {
    // Nunca se persisten contraseñas en claro: van a la bóveda.
    await this.servers.write(list.map(({ password: _p, ...rest }) => rest));
  }

  knownHost(id: string): string | undefined {
    return this.knownCache[id];
  }

  async setKnownHost(id: string, fp: string): Promise<void> {
    this.knownCache = { ...this.knownCache, [id]: fp };
    await this.known.write(this.knownCache);
  }
}
