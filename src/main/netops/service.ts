// Servicio de operaciones de red para el proceso principal: lanza despliegues y respaldos,
// lleva la cuenta de los trabajos en curso y ejecuta los respaldos programados.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store';
import type { Vault } from '../vault';
import { JobRunner, RunnerDeps } from './runner';
import { runDeploy } from './deploy';
import { listAllBackups, listDeviceBackups, runBackup, VENDORS } from './backup';
import { renderTemplate, safeName, parseCsv } from '../../shared/template';
import type { BackupJob, ConfigTemplate, DeployJob, HostKeyPrompt, JobProgress, NetDevice, SessionConfig } from '../../shared/types';

export interface NetOpsDeps {
  store: Store;
  vault: Vault;
  confirmHostKey(p: HostKeyPrompt): Promise<boolean>;
  progress(p: JobProgress): void;
  notify(msg: string, kind: 'info' | 'ok' | 'error'): void;
}

/** Clave de la bóveda con las credenciales de los respaldos programados. */
export const SCHEDULE_SECRET = 'netops:schedule';

export class NetOps {
  private jobs = new Map<string, JobRunner>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: NetOpsDeps) {}

  get deployDir(): string {
    return join(this.d.store.dir, 'deploy');
  }

  async backupDir(): Promise<string> {
    const s = await this.d.store.getSettings();
    return s.backupDir || join(this.d.store.dir, 'backups');
  }

  private async runnerDeps(): Promise<RunnerDeps> {
    const sessions = await this.d.store.listSessions();
    return {
      sessionById: (id) => sessions.find((s) => s.id === id),
      secretFor: (id) => (this.d.vault.isUnlocked() ? this.d.vault.get(id) : undefined),
      knownHosts: { get: (id) => this.d.store.knownHost(id), set: (id, fp) => this.d.store.setKnownHost(id, fp) },
      confirmHostKey: (p) => this.d.confirmHostKey(p),
    };
  }

  private track(r: { runner: JobRunner; done: Promise<JobProgress> }): string {
    this.jobs.set(r.runner.id, r.runner);
    void r.done.finally(() => this.jobs.delete(r.runner.id));
    return r.runner.id;
  }

  async deploy(job: DeployJob): Promise<string> {
    return this.track(runDeploy(job, await this.runnerDeps(), this.deployDir, this.d.progress));
  }

  async backup(job: BackupJob): Promise<string> {
    return this.track(runBackup(job, await this.runnerDeps(), await this.backupDir(), this.d.progress));
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.cancel();
  }

  vendors(): { id: string; label: string; command: string }[] {
    return VENDORS.map(({ id, label, command }) => ({ id, label, command }));
  }

  async listBackups(): Promise<{ dir: string; devices: { device: string; count: number; last: number }[] }> {
    const dir = await this.backupDir();
    return { dir, devices: await listAllBackups(dir) };
  }

  async deviceBackups(device: string) {
    return listDeviceBackups(await this.backupDir(), device);
  }

  /** Lee un respaldo (sólo dentro de la carpeta de respaldos). */
  async readBackup(file: string): Promise<string> {
    const dir = await this.backupDir();
    const rel = file.startsWith(dir) ? file.slice(dir.length) : '';
    if (!rel || rel.includes('..')) throw new Error('Archivo fuera de la carpeta de respaldos.');
    return fs.readFile(file, 'utf8');
  }

  /** Genera un archivo de configuración por equipo a partir de una plantilla y un CSV. */
  async exportTemplate(t: ConfigTemplate, csv: string, outDir: string): Promise<{ files: string[]; missing: Record<string, string[]> }> {
    const { rows } = parseCsv(csv);
    if (!rows.length) throw new Error('El CSV no tiene filas.');
    await fs.mkdir(outDir, { recursive: true });
    const files: string[] = [];
    const missing: Record<string, string[]> = {};
    for (const [i, row] of rows.entries()) {
      const name = row.name || row.nombre || row.host || `equipo-${i + 1}`;
      const r = renderTemplate(t.body, row);
      if (r.missing.length) missing[name] = r.missing;
      const f = join(outDir, `${safeName(name)}.cfg`);
      await fs.writeFile(f, r.text.endsWith('\n') ? r.text : r.text + '\n');
      files.push(f);
    }
    return { files, missing };
  }

  // --- Respaldos programados ------------------------------------------------

  async schedule(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = (await this.d.store.getSettings()).backupSchedule;
    if (!s.enabled || !s.devices.length) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 30_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lanza el respaldo programado si toca. Devuelve el id del trabajo o null. */
  async tick(force = false): Promise<string | null> {
    const settings = await this.d.store.getSettings();
    const s = settings.backupSchedule;
    if (!s.enabled && !force) return null;
    if (!force && s.lastRun && Date.now() - s.lastRun < s.everyHours * 3600_000) return null;
    if ([...this.jobs.values()].length) return null;
    const sessions = await this.d.store.listSessions();
    const devices = s.devices
      .map((d) => sessions.find((x) => x.id === d.sessionId) && { ...sessionDevice(sessions.find((x) => x.id === d.sessionId)!), vendor: d.vendor })
      .filter(Boolean) as NetDevice[];
    if (!devices.length) return null;
    if (!this.d.vault.isUnlocked()) {
      if (force) throw new Error('Desbloquea la bóveda: los respaldos programados toman de ella las contraseñas.');
      return null;
    }
    const cred = this.d.vault.get(SCHEDULE_SECRET);
    await this.d.store.saveSettings({ backupSchedule: { ...s, lastRun: Date.now() } });
    const id = await this.backup({
      name: 'respaldo-programado',
      devices,
      credentials: cred ? { password: cred.password } : undefined,
      enablePassword: cred?.passphrase,
      concurrency: 5,
      timeoutSec: 60,
      acceptNewHostKeys: false,
    });
    this.d.notify(`Respaldo programado iniciado (${devices.length} equipos).`, 'info');
    return id;
  }
}

/** Convierte una sesión guardada SSH/Telnet en un equipo para los trabajos masivos. */
export function sessionDevice(s: SessionConfig): NetDevice {
  return { id: s.id, name: s.name, host: s.host || '', port: s.port, protocol: s.kind === 'telnet' ? 'telnet' : 'ssh', sessionId: s.id, username: s.username };
}
