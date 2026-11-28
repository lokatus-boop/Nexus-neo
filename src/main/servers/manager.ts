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
import { SftpServer } from './sftp';
import { DhcpServer } from './dhcp';
import type { NetInterfaceInfo, ServerConfig, ServerKind, ServerLogEntry, ServerStatus } from '../../shared/types';

const MAX_LOG = 2000;

export function defaultServers(base = join(homedir(), 'NexusNeo')): ServerConfig[] {
  const mk = (kind: ServerKind, name: string, port: number, extra: Partial<ServerConfig> = {}): ServerConfig => ({
    id: randomUUID(), kind, name, port, bindHost: '0.0.0.0', rootDir: join(base, kind === 'syslog' ? 'syslog' : kind === 'dhcp' ? 'dhcp' : 'compartido'), allowWrite: kind !== 'http' && kind !== 'https', ...extra,
  });
  return [
    mk('tftp', 'TFTP', 69),
    mk('ftp', 'FTP', 21, { anonymous: false, username: 'nexus', password: '', pasvMin: 50000, pasvMax: 50100 }),
    // El 22 suele estar ocupado por el sshd del propio equipo.
    mk('sftp', 'SFTP / SCP', 2222, { username: 'nexus', password: '' }),
    mk('http', 'HTTP', 8080),
    mk('https', 'HTTPS', 8443),
    mk('syslog', 'Syslog', 514, { syslogTcp: false, syslogToFile: true }),
    mk('dhcp', 'DHCP', 67, {
      allowWrite: false, dhcpPoolStart: '192.168.50.100', dhcpPoolEnd: '192.168.50.200', dhcpSubnetMask: '255.255.255.0',
      dhcpRouter: '', dhcpDns: '', dhcpLeaseSecs: 86400, dhcpReservations: [],
    }),
  ];
}

/**
 * Añade a una lista guardada los tipos de servidor que no tenía (versiones anteriores),
 * colocados en el orden por defecto. Devuelve null si no falta ninguno.
 */
export function addMissingKinds(list: ServerConfig[], base?: string): ServerConfig[] | null {
  const defaults = defaultServers(base);
  const missing = defaults.filter((d) => !list.some((c) => c.kind === d.kind));
  if (!missing.length) return null;
  const order = defaults.map((d) => d.kind);
  return [...list, ...missing].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
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

export function createServerFor(cfg: ServerConfig, stateDir?: string): BuiltinServer {
  switch (cfg.kind) {
    case 'tftp':
      return new TftpServer(cfg, stateDir);
    case 'ftp':
      return new FtpServer(cfg, stateDir);
    case 'http':
    case 'https':
      return new HttpFileServer(cfg, stateDir);
    case 'sftp':
      return new SftpServer(cfg, stateDir);
    case 'syslog':
      return new SyslogServer(cfg, stateDir);
    case 'dhcp':
      return new DhcpServer(cfg, stateDir);
  }
}

export class ServerManager extends EventEmitter {
  private running = new Map<string, BuiltinServer>();
  private lastError = new Map<string, string>();
  private logs: ServerLogEntry[] = [];

  /** @param stateDir carpeta privada para claves de host y certificados generados. */
  constructor(public stateDir?: string) {
    super();
  }

  status(configs: ServerConfig[]): ServerStatus[] {
    return configs.map((c) => {
      const s = this.running.get(c.id);
      return { id: c.id, running: !!s?.running, active: s?.active ?? 0, error: s ? undefined : this.lastError.get(c.id), ...(s?.details() ?? {}) };
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
    const srv = createServerFor(cfg, this.stateDir);
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
