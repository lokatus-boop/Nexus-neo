// Motor común del despliegue masivo y de los respaldos: conecta con muchos equipos en
// paralelo (con límite), ejecuta una tarea en cada uno y guarda el resultado de cada equipo.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Client } from 'ssh2';
import { connectClient, SshDeps } from '../protocols/ssh';
import { CliSession, CliOptions, sshStream, telnetStream } from './cli';
import { safeName } from '../../shared/template';
import type { DeviceRunResult, JobProgress, NetDevice, SecretEntry, SessionConfig } from '../../shared/types';

export interface RunnerDeps {
  sessionById(id: string): SessionConfig | undefined;
  secretFor(id: string): SecretEntry | undefined;
  knownHosts: SshDeps['knownHosts'];
  /** Huella desconocida o cambiada: decide (por defecto se pregunta al usuario). */
  confirmHostKey: SshDeps['prompter']['hostKey'];
}

export interface DeviceConnection {
  device: NetDevice;
  cli: CliSession;
  /** Cliente SSH (null en Telnet), para subir archivos. */
  ssh: Client | null;
  log(line: string): void;
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface ConnectOptions extends CliOptions {
  credentials?: { username?: string; password?: string };
  acceptNewHostKeys: boolean;
}

/** Abre una sesión de línea de órdenes con un equipo (SSH o Telnet) e inicia sesión. */
export async function openDevice(dev: NetDevice, deps: RunnerDeps, opts: ConnectOptions, log: (l: string) => void): Promise<{ cli: CliSession; ssh: Client | null; banner: string }> {
  const saved = dev.sessionId ? deps.sessionById(dev.sessionId) : undefined;
  const secret = saved ? deps.secretFor(saved.id) : undefined;
  const username = dev.username || saved?.username || opts.credentials?.username;
  const password = secret?.password ?? opts.credentials?.password;
  const port = dev.port || saved?.port || (dev.protocol === 'telnet' ? 23 : 22);
  if (dev.protocol === 'telnet') {
    log(`Conectando por Telnet a ${dev.host}:${port}…`);
    const stream = await telnetStream(dev.host, port, Math.min(opts.timeoutMs ?? 30000, 20000));
    const cli = new CliSession(stream, opts);
    const banner = await cli.login({ username, password });
    return { cli, ssh: null, banner };
  }
  const cfg: SessionConfig = saved
    ? { ...saved, host: dev.host || saved.host, port }
    : { id: `dev-${dev.id}`, name: dev.name, folder: '', kind: 'ssh', host: dev.host, port, username, auth: 'password' };
  if (!cfg.username && username) cfg.username = username;
  log(`Conectando por SSH a ${cfg.username ? cfg.username + '@' : ''}${dev.host}:${port}…`);
  const sshDeps: SshDeps = {
    knownHosts: deps.knownHosts,
    secretFor: (id) => (id === cfg.id ? (password ? { ...secret, password } : secret) : deps.secretFor(id)),
    sessionById: deps.sessionById,
    onTunnelsChanged: () => undefined,
    prompter: {
      hostKey: async (p) => {
        if (!p.previous && opts.acceptNewHostKeys) {
          log(`Huella nueva aceptada: ${p.fingerprint}`);
          return true;
        }
        if (p.previous) log(`⚠ La huella del equipo ha cambiado (antes ${p.previous}, ahora ${p.fingerprint}).`);
        return deps.confirmHostKey(p);
      },
      // En modo desatendido no se pregunta nada: si falta la contraseña, la autenticación falla.
      auth: async (p) => (p.prompts.length === 1 && /password|contraseña/i.test(p.prompts[0].prompt) && password ? [password] : null),
    },
  };
  const client = await connectClient(cfg, sshDeps);
  try {
    const cli = new CliSession(await sshStream(client), opts);
    const banner = await cli.login({ username, password });
    return { cli, ssh: client, banner };
  } catch (e) {
    client.end();
    throw e;
  }
}

export type DeviceTask = (conn: DeviceConnection, result: DeviceRunResult) => Promise<void>;

export interface RunOptions extends ConnectOptions {
  kind: 'deploy' | 'backup';
  name: string;
  devices: NetDevice[];
  concurrency: number;
  /** Carpeta donde se guarda el resultado de la ejecución. */
  outDir: string;
}

export class JobRunner {
  readonly id = randomUUID();
  private cancelled = false;
  readonly results: DeviceRunResult[];

  constructor(private readonly opts: RunOptions, private readonly deps: RunnerDeps, private readonly onProgress: (p: JobProgress) => void) {
    this.results = opts.devices.map((d) => ({ deviceId: d.id, name: d.name, host: d.host, status: 'pending', output: '' }));
  }

  cancel(): void {
    this.cancelled = true;
  }

  private progress(done = false): void {
    this.onProgress({ jobId: this.id, kind: this.opts.kind, name: this.opts.name, dir: this.opts.outDir, results: this.results.map((r) => ({ ...r })), done });
  }

  async run(task: DeviceTask): Promise<JobProgress> {
    await fs.mkdir(this.opts.outDir, { recursive: true });
    let next = 0;
    let lastEmit = 0;
    const emit = () => {
      if (Date.now() - lastEmit > 200) {
        lastEmit = Date.now();
        this.progress();
      }
    };
    const worker = async () => {
      while (next < this.opts.devices.length) {
        const i = next++;
        const dev = this.opts.devices[i];
        const r = this.results[i];
        if (this.cancelled) {
          r.status = 'cancelled';
          continue;
        }
        r.status = 'running';
        r.startedAt = Date.now();
        this.progress();
        const log = (line: string) => {
          r.output += `${line}\n`;
          emit();
        };
        let conn: { cli: CliSession; ssh: Client | null } | null = null;
        try {
          const o = await openDevice(dev, this.deps, this.opts, log);
          conn = o;
          log(o.banner.trim());
          await task({ device: dev, cli: o.cli, ssh: o.ssh, log }, r);
          if (r.status === 'running') r.status = 'ok';
        } catch (e) {
          r.status = 'error';
          r.message = (e as Error).message;
          log(`✖ ${r.message}`);
        } finally {
          conn?.cli.close();
          r.endedAt = Date.now();
          r.logFile = join(this.opts.outDir, `${safeName(dev.name || dev.host)}.log`);
          await fs.writeFile(r.logFile, r.output).catch(() => undefined);
          this.progress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.opts.concurrency, 50)) }, worker));
    await this.writeSummary();
    const final: JobProgress = { jobId: this.id, kind: this.opts.kind, name: this.opts.name, dir: this.opts.outDir, results: this.results, done: true };
    this.onProgress(final);
    return final;
  }

  private async writeSummary(): Promise<void> {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = ['equipo;host;estado;segundos;mensaje;cambios', ...this.results.map((r) =>
      [q(r.name), q(r.host), r.status, r.startedAt && r.endedAt ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) : '', q(r.message || ''), r.changed === undefined ? '' : r.changed ? 'sí' : 'no'].join(';'))];
    await fs.writeFile(join(this.opts.outDir, 'resumen.csv'), '﻿' + lines.join('\r\n') + '\r\n');
    await fs.writeFile(join(this.opts.outDir, 'resumen.json'), JSON.stringify({ name: this.opts.name, kind: this.opts.kind, results: this.results.map(({ output: _o, ...r }) => r) }, null, 2));
  }
}
