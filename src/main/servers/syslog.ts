// Servidor Syslog (RFC 3164 / RFC 5424) por UDP y opcionalmente TCP, con guardado diario en archivo.
import { createSocket, Socket as UdpSocket } from 'node:dgram';
import { createServer, Server, Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BuiltinServer, friendlyListenError } from './common';

export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export function parseSyslog(raw: string): { facility: number; severity: number; text: string } {
  const m = /^<(\d{1,3})>(.*)$/s.exec(raw.trim());
  if (!m) return { facility: 1, severity: 5, text: raw.trim() };
  const pri = Math.min(Number(m[1]), 191);
  return { facility: pri >> 3, severity: pri & 7, text: m[2].trim() };
}

/** Divide un flujo TCP en mensajes: soporta octet-counting (RFC 6587) y separación por saltos de línea. */
export function splitTcpFrames(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const oc = /^(\d+) /.exec(rest);
    if (oc) {
      const len = Number(oc[1]);
      const start = oc[0].length;
      if (Buffer.byteLength(rest.slice(start)) < len) break;
      // Aproximación por caracteres: suficiente para mensajes ASCII/UTF-8 habituales.
      messages.push(rest.slice(start, start + len));
      rest = rest.slice(start + len).replace(/^\r?\n/, '');
      continue;
    }
    const nl = rest.indexOf('\n');
    if (nl < 0) break;
    const line = rest.slice(0, nl).replace(/\r$/, '');
    if (line) messages.push(line);
    rest = rest.slice(nl + 1);
  }
  return { messages, rest };
}

export class SyslogServer extends BuiltinServer {
  private udp: UdpSocket | null = null;
  private tcp: Server | null = null;
  private sockets = new Set<Socket>();
  private writeQueue: Promise<void> = Promise.resolve();

  boundPort(): number | undefined {
    try {
      return this.udp?.address().port;
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    if (this.cfg.syslogToFile) await fs.mkdir(this.cfg.rootDir, { recursive: true });
    const udp = createSocket(this.cfg.bindHost.includes(':') ? 'udp6' : 'udp4');
    await new Promise<void>((resolve, reject) => {
      udp.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      udp.bind(this.cfg.port, this.cfg.bindHost || '0.0.0.0', () => resolve());
    });
    udp.on('message', (msg, rinfo) => this.receive(msg.toString('utf8'), rinfo.address));
    udp.on('error', (e) => this.log('error', e.message));
    this.udp = udp;

    if (this.cfg.syslogTcp) {
      const tcp = createServer((sock) => {
        this.sockets.add(sock);
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (d: string) => {
          const r = splitTcpFrames(buf + d);
          buf = r.rest.length > 65536 ? '' : r.rest;
          for (const m of r.messages) this.receive(m, sock.remoteAddress || '?');
        });
        sock.on('error', () => undefined);
        sock.on('close', () => this.sockets.delete(sock));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          tcp.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.boundPort() || this.cfg.port))));
          tcp.listen(this.boundPort(), this.cfg.bindHost || '0.0.0.0', () => resolve());
        });
      } catch (e) {
        udp.close();
        this.udp = null;
        throw e;
      }
      this.tcp = tcp;
    }
    this.running = true;
    this.log('info', `Syslog escuchando en ${this.cfg.bindHost || '0.0.0.0'}:${this.boundPort()} (UDP${this.tcp ? ' y TCP' : ''})${this.cfg.syslogToFile ? ` · guardando en ${this.cfg.rootDir}` : ''}`);
    this.changed();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.udp ? this.udp.close(() => r()) : r()));
    await new Promise<void>((r) => (this.tcp ? this.tcp.close(() => r()) : r()));
    await this.writeQueue;
    this.udp = null;
    this.tcp = null;
    this.running = false;
    this.log('info', 'Syslog detenido');
    this.changed();
  }

  /** Último mensaje escrito (para pruebas). */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private receive(raw: string, from: string): void {
    const addr = from.replace(/^::ffff:/, '');
    const parsed = parseSyslog(raw);
    this.log('syslog', `${addr} [${SEVERITIES[parsed.severity]}] ${parsed.text}`, { syslog: { from: addr, ...parsed } });
    if (this.cfg.syslogToFile) {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const line = `${now.toISOString()} ${addr} ${SEVERITIES[parsed.severity]} ${parsed.text}\n`;
      const file = join(this.cfg.rootDir, `syslog-${day}.log`);
      this.writeQueue = this.writeQueue.then(() => fs.appendFile(file, line)).catch((e) => this.log('error', `No se pudo escribir el log: ${e.message}`));
    }
  }
}
