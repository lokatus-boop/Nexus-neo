// Orquesta la sincronización: configuración, frase guardada en la bóveda, sincronización
// automática (al arrancar, cada N minutos y poco después de cada cambio) y estado para la UI.
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import type { SFTPWrapper } from 'ssh2';
import { FolderTarget, SftpTarget, SyncItem, SyncTarget, syncOnce } from './sync';
import type { Store } from './store';
import type { Vault } from './vault';
import type { SecretEntry, SyncSettings, SyncStatus } from '../shared/types';

export interface SyncCollection {
  name: string;
  list(): Promise<SyncItem[]>;
  replace(items: SyncItem[]): Promise<void>;
}

export interface SyncDeps {
  store: Store;
  vault: Vault;
  collections: SyncCollection[];
  /** Abre SFTP a través de una sesión SSH guardada (y devuelve cómo cerrarla). */
  openSftp(sessionId: string): Promise<{ sftp: SFTPWrapper; close(): void; label: string }>;
}

const PASS_ID = 'sync:passphrase';

export class SyncManager extends EventEmitter {
  private memoryPassphrase: string | null = null;
  private status: SyncStatus = { configured: false, hasPassphrase: false, running: false };
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running: Promise<SyncStatus> | null = null;
  private applying = false;

  constructor(private readonly deps: SyncDeps) {
    super();
  }

  private passphrase(): string | null {
    if (this.memoryPassphrase) return this.memoryPassphrase;
    return this.deps.vault.isUnlocked() ? this.deps.vault.get(PASS_ID)?.password ?? null : null;
  }

  async getStatus(): Promise<SyncStatus> {
    const s = (await this.deps.store.getSettings()).sync;
    return { ...this.status, configured: !!(s.enabled && s.path && (s.mode === 'folder' || s.sessionId)), hasPassphrase: !!this.passphrase() };
  }

  /** Guarda la frase: en la bóveda si está abierta (así se recuerda), si no sólo en memoria. */
  async setPassphrase(p: string | null): Promise<void> {
    if (p !== null && p.length < 8) throw new Error('La frase de sincronización debe tener al menos 8 caracteres.');
    this.memoryPassphrase = p;
    if (this.deps.vault.isUnlocked()) {
      if (p) await this.deps.vault.set(PASS_ID, { password: p });
      else await this.deps.vault.remove(PASS_ID);
      this.memoryPassphrase = null;
    }
  }

  /** Reprograma la sincronización periódica según los ajustes. */
  async schedule(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = (await this.deps.store.getSettings()).sync;
    if (s.enabled && s.intervalMin > 0) this.timer = setInterval(() => void this.run(true), s.intervalMin * 60_000);
    this.timer?.unref?.();
  }

  /** Llamar cuando cambian datos locales: sincroniza unos segundos después. */
  localChanged(): void {
    if (this.applying) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.run(true), 5000);
    this.debounce.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }

  private async target(s: SyncSettings): Promise<{ target: SyncTarget; close(): void }> {
    if (s.mode === 'folder') return { target: new FolderTarget(s.path), close: () => undefined };
    if (!s.sessionId) throw new Error('Elige la sesión SSH del servidor de sincronización.');
    const c = await this.deps.openSftp(s.sessionId);
    return { target: new SftpTarget(async () => c.sftp, s.path, c.label), close: c.close };
  }

  /** Sincroniza ahora. En modo automático no lanza errores: los deja en el estado. */
  run(auto = false): Promise<SyncStatus> {
    if (this.running) return this.running;
    this.running = this.doRun(auto).finally(() => (this.running = null));
    return this.running;
  }

  private async doRun(auto: boolean): Promise<SyncStatus> {
    const settings = await this.deps.store.getSettings();
    const s = settings.sync;
    if (!s.enabled || !s.path) {
      if (auto) return this.getStatus();
      throw new Error('Configura primero la sincronización.');
    }
    const pass = this.passphrase();
    if (!pass) {
      if (auto) return this.getStatus();
      throw new Error('Falta la frase de sincronización (o desbloquea la bóveda donde está guardada).');
    }
    this.status = { ...this.status, running: true };
    this.emit('status', await this.getStatus());
    let close = () => undefined as void;
    try {
      const t = await this.target(s);
      close = t.close;
      const { store, vault } = this.deps;
      const collections: Record<string, SyncItem[]> = {};
      for (const c of this.deps.collections) collections[c.name] = await c.list();
      const useSecrets = s.includeSecrets && vault.isUnlocked();
      let secrets: Record<string, SecretEntry & { updatedAt: number }> | undefined;
      if (useSecrets) {
        secrets = {};
        for (const sess of collections.sessions || []) {
          const sec = vault.get(sess.id);
          if (sec) secrets[sess.id] = { ...sec, updatedAt: sess.updatedAt ?? 0 };
        }
      }
      const device = s.deviceName || hostname();
      const { bundle, stats } = await syncOnce(t.target, pass, { collections, deleted: await store.tombstones(), secrets }, device);
      // Aplica el resultado en local (sin volver a disparar la sincronización).
      this.applying = true;
      try {
        for (const c of this.deps.collections) {
          const before = JSON.stringify(collections[c.name]);
          const after = bundle.collections[c.name] || [];
          if (JSON.stringify(after) !== before) await c.replace(after);
        }
        await store.setTombstones(bundle.deleted);
        if (useSecrets) {
          for (const [id, sec] of Object.entries(bundle.secrets)) {
            const cur = vault.get(id);
            if (cur?.password !== sec.password || cur?.passphrase !== sec.passphrase) await vault.set(id, { password: sec.password, passphrase: sec.passphrase });
          }
        }
      } finally {
        this.applying = false;
      }
      this.status = {
        ...this.status,
        running: false,
        lastSync: Date.now(),
        lastError: undefined,
        lastResult: { ...stats, devices: Object.keys(bundle.devices), time: bundle.updatedAt },
      };
      this.emit('applied', stats);
    } catch (e) {
      this.status = { ...this.status, running: false, lastError: (e as Error).message };
      if (!auto) {
        this.emit('status', await this.getStatus());
        throw e;
      }
    } finally {
      close();
    }
    const st = await this.getStatus();
    this.emit('status', st);
    return st;
  }
}
