// Gestor de los servidores integrados: configuración persistente, arranque/parada y registro.
import { EventEmitter } from 'node:events';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BuiltinServer } from './common';
import { TftpServer } from './tftp';
import { FtpServer } from './ftp';
import { HttpFileServer } from './http';
import { SyslogServer } from './syslog';
import type { NetInterfaceInfo, ServerConfig, ServerKind, ServerLogEntry, ServerStatus } from '../../shared/types';

const MAX_LOG = 2000;

export function defaultServers(base = join(homedir(), 'NexusNeo')): ServerConfig[] {
  const mk = (kind: ServerKind, name: string, port: number, extra: Partial<ServerConfig> = {}): ServerConfig => ({
    id: randomUUID(), kind, name, port, bindHost: '0.0.0.0', rootDir: join(base, kind === 'syslog' ? 'syslog' : 'compartido'), allowWrite: kind !== 'http', ...extra,
  });
  return [
    mk('tftp', 'TFTP', 69),
    mk('ftp', 'FTP', 21, { anonymous: false, username: 'nexus', password: '', pasvMin: 50000, pasvMax: 50100 }),
    mk('http', 'HTTP', 8080),
    mk('syslog', 'Syslog', 514, { syslogTcp: false, syslogToFile: true }),
  ];
}

export function listInterfaces(): NetInterfaceInfo[] {
  const out: NetInterfaceInfo[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv6' && a.address.startsWith('fe80')) continue;
      out.push({ name, address: a.address, family: a.family as 'IPv4' | 'IPv6' });
    }
  }
  return out.sort((a, b) => (a.family === b.family ? a.name.localeCompare(b.name) : a.family === 'IPv4' ? -1 : 1));
}

export function createServerFor(cfg: ServerConfig): BuiltinServer {
  switch (cfg.kind) {
    case 'tftp':
      return new TftpServer(cfg);
    case 'ftp':
      return new FtpServer(cfg);
    case 'http':
      return new HttpFileServer(cfg);
    case 'syslog':
      return new SyslogServer(cfg);
  }
}

export class ServerManager extends EventEmitter {
  private running = new Map<string, BuiltinServer>();
  private lastError = new Map<string, string>();
  private logs: ServerLogEntry[] = [];

  status(configs: ServerConfig[]): ServerStatus[] {
    return configs.map((c) => {
      const s = this.running.get(c.id);
      return { id: c.id, running: !!s?.running, active: s?.active ?? 0, error: s ? undefined : this.lastError.get(c.id) };
    });
  }

  recentLogs(): ServerLogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  isRunning(id: string): boolean {
    return !!this.running.get(id)?.running;
  }

  async start(cfg: ServerConfig): Promise<void> {
    if (this.running.has(cfg.id)) return;
    const srv = createServerFor(cfg);
    srv.on('log', (e: ServerLogEntry) => this.pushLog(e));
    srv.on('status', () => this.emit('status'));
    try {
      await srv.start();
      this.lastError.delete(cfg.id);
      this.running.set(cfg.id, srv);
    } catch (e) {
      const msg = (e as Error).message;
      this.lastError.set(cfg.id, msg);
      this.pushLog({ serverId: cfg.id, time: Date.now(), level: 'error', message: `${cfg.name}: ${msg}` });
      this.emit('status');
      throw e;
    }
    this.emit('status');
  }

  async stop(id: string): Promise<void> {
    const srv = this.running.get(id);
    if (!srv) return;
    this.running.delete(id);
    await srv.stop();
    this.emit('status');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private pushLog(e: ServerLogEntry): void {
    this.logs.push(e);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.emit('log', e);
  }
}
