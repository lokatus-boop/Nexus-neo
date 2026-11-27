// Gestión de túneles SSH (local -L, remoto -R y dinámico/SOCKS -D) sobre un cliente ssh2.
import { createServer, connect, Server, Socket } from 'node:net';
import type { Client, ClientChannel } from 'ssh2';
import { socks5Handshake } from './socks5';
import type { TunnelConfig, TunnelStatus } from '../../shared/types';

interface RunningTunnel {
  cfg: TunnelConfig;
  server?: Server;
  state: TunnelStatus['state'];
  error?: string;
  sockets: Set<Socket | ClientChannel>;
}

export function describeTunnel(t: TunnelConfig): string {
  if (t.type === 'local') return `L ${t.bindHost}:${t.bindPort} → ${t.destHost}:${t.destPort}`;
  if (t.type === 'remote') return `R (remoto) ${t.bindHost}:${t.bindPort} → ${t.destHost}:${t.destPort}`;
  return `D SOCKS5 ${t.bindHost}:${t.bindPort}`;
}

export class TunnelManager {
  private tunnels = new Map<string, RunningTunnel>();
  private remoteHandlerInstalled = false;

  constructor(private readonly client: Client, private readonly connId: string, private readonly onChange: () => void) {}

  configure(list: TunnelConfig[]): void {
    for (const t of list) {
      if (!this.tunnels.has(t.id)) this.tunnels.set(t.id, { cfg: t, state: 'stopped', sockets: new Set() });
    }
  }

  async startAuto(): Promise<void> {
    for (const t of this.tunnels.values()) if (t.cfg.autoStart) await this.start(t.cfg.id).catch(() => undefined);
  }

  add(cfg: TunnelConfig): void {
    this.tunnels.set(cfg.id, { cfg, state: 'stopped', sockets: new Set() });
    this.onChange();
  }

  status(): TunnelStatus[] {
    return [...this.tunnels.values()].map((t) => ({
      connId: this.connId,
      tunnelId: t.cfg.id,
      name: t.cfg.name || describeTunnel(t.cfg),
      type: t.cfg.type,
      description: describeTunnel(t.cfg),
      state: t.state,
      error: t.error,
      activeConnections: Math.ceil(t.sockets.size / 2),
    }));
  }

  async start(id: string): Promise<void> {
    const t = this.tunnels.get(id);
    if (!t || t.state === 'listening') return;
    t.error = undefined;
    try {
      if (t.cfg.type === 'remote') await this.startRemote(t);
      else await this.startLocalOrDynamic(t);
      t.state = 'listening';
    } catch (e) {
      t.state = 'error';
      t.error = (e as Error).message;
      throw e;
    } finally {
      this.onChange();
    }
  }

  async stop(id: string): Promise<void> {
    const t = this.tunnels.get(id);
    if (!t) return;
    for (const s of t.sockets) s.destroy();
    t.sockets.clear();
    if (t.server) {
      await new Promise<void>((r) => t.server!.close(() => r()));
      t.server = undefined;
    }
    if (t.cfg.type === 'remote' && t.state === 'listening') {
      await new Promise<void>((r) => this.client.unforwardIn(t.cfg.bindHost, t.cfg.bindPort, () => r()));
    }
    t.state = 'stopped';
    this.onChange();
  }

  async stopAll(): Promise<void> {
    for (const id of this.tunnels.keys()) await this.stop(id).catch(() => undefined);
  }

  private track(t: RunningTunnel, a: Socket | ClientChannel, b?: Socket | ClientChannel): void {
    t.sockets.add(a);
    if (b) t.sockets.add(b);
    this.onChange();
    const done = () => {
      const da = t.sockets.delete(a);
      const db = b ? t.sockets.delete(b) : false;
      if (da || db) this.onChange();
    };
    a.once('close', done);
    b?.once('close', done);
  }

  private pipe(local: Socket, remote: ClientChannel): void {
    local.pipe(remote).pipe(local);
    local.on('error', () => remote.destroy());
    remote.on('error', () => local.destroy());
    local.on('close', () => remote.destroy());
    remote.on('close', () => local.destroy());
  }

  private startLocalOrDynamic(t: RunningTunnel): Promise<void> {
    const server = createServer(async (sock) => {
      sock.on('error', () => undefined);
      let dest = { host: t.cfg.destHost, port: t.cfg.destPort };
      let reply: ((ok: boolean) => void) | undefined;
      if (t.cfg.type === 'dynamic') {
        try {
          const hs = await socks5Handshake(sock);
          dest = hs.req;
          reply = hs.reply;
        } catch {
          return;
        }
      }
      this.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, dest.host, dest.port, (err, stream) => {
        if (err) {
          reply?.(false);
          sock.destroy();
          return;
        }
        reply?.(true);
        this.track(t, sock, stream);
        this.pipe(sock, stream);
      });
    });
    t.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(t.cfg.bindPort, t.cfg.bindHost || '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (e) => {
          t.state = 'error';
          t.error = e.message;
          this.onChange();
        });
        resolve();
      });
    });
  }

  private startRemote(t: RunningTunnel): Promise<void> {
    if (!this.remoteHandlerInstalled) {
      this.remoteHandlerInstalled = true;
      this.client.on('tcp connection', (info, accept, rejectConn) => {
        const match = [...this.tunnels.values()].find(
          (x) => x.cfg.type === 'remote' && x.state === 'listening' && x.cfg.bindPort === info.destPort,
        );
        if (!match) return rejectConn();
        const local = connect(match.cfg.destPort, match.cfg.destHost, () => {
          const stream = accept();
          this.track(match, local, stream);
          this.pipe(local, stream);
        });
        local.on('error', () => rejectConn());
      });
    }
    return new Promise((resolve, reject) => {
      this.client.forwardIn(t.cfg.bindHost || '127.0.0.1', t.cfg.bindPort, (err) => (err ? reject(err) : resolve()));
    });
  }
}
