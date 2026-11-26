// Servidor TFTP (RFC 1350) con opciones blksize, tsize y timeout (RFC 2347/2348/2349).
// Cada transferencia usa su propio socket efímero, como exige el protocolo.
import { createSocket, Socket, RemoteInfo } from 'node:dgram';
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { BuiltinServer, safeResolve, friendlyListenError } from './common';

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 } as const;
const ERR = { UNDEFINED: 0, NOT_FOUND: 1, ACCESS: 2, DISK_FULL: 3, ILLEGAL: 4, UNKNOWN_TID: 5, EXISTS: 6, OPTION: 8 } as const;
const MAX_RETRIES = 5;

export interface TftpRequest {
  op: number;
  filename: string;
  mode: string;
  options: Record<string, string>;
}

export function parseRequest(msg: Buffer): TftpRequest | null {
  if (msg.length < 4) return null;
  const op = msg.readUInt16BE(0);
  if (op !== OP.RRQ && op !== OP.WRQ) return null;
  const parts = msg.subarray(2).toString('latin1').split('\0');
  if (parts.length < 3) return null;
  const [filename, mode, ...rest] = parts;
  const options: Record<string, string> = {};
  for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i]) options[rest[i].toLowerCase()] = rest[i + 1];
  return { op, filename, mode: mode.toLowerCase(), options };
}

function errorPacket(code: number, msg: string): Buffer {
  return Buffer.concat([Buffer.from([0, OP.ERROR, 0, code]), Buffer.from(msg, 'latin1'), Buffer.from([0])]);
}

function oackPacket(opts: Record<string, string>): Buffer {
  const body = Object.entries(opts).flatMap(([k, v]) => [Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1'), Buffer.from([0])]);
  return Buffer.concat([Buffer.from([0, OP.OACK]), ...body]);
}

function ack(block: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(OP.ACK, 0);
  b.writeUInt16BE(block & 0xffff, 2);
  return b;
}

/** Canal de una transferencia: envía un paquete y espera la respuesta esperada con reintentos. */
class Channel {
  private sock: Socket;
  private waiter: ((msg: Buffer) => boolean) | null = null;
  private resolveWait: ((msg: Buffer) => void) | null = null;
  closed = false;

  constructor(private readonly peer: RemoteInfo, private readonly timeoutMs: number) {
    this.sock = createSocket(peer.family === 'IPv6' ? 'udp6' : 'udp4');
    this.sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== peer.address || rinfo.port !== peer.port) {
        this.sock.send(errorPacket(ERR.UNKNOWN_TID, 'TID desconocido'), rinfo.port, rinfo.address);
        return;
      }
      if (this.waiter && this.waiter(msg)) {
        const r = this.resolveWait!;
        this.waiter = null;
        this.resolveWait = null;
        r(msg);
      }
    });
    this.sock.on('error', () => void this.close());
  }

  bind(): Promise<void> {
    return new Promise((r) => this.sock.bind(0, () => r()));
  }

  private inflight = new Set<Promise<void>>();

  send(pkt: Buffer): void {
    if (this.closed) return;
    // dgram.send es asíncrono: cerrar el socket antes de que termine descarta el paquete.
    const p = new Promise<void>((r) => this.sock.send(pkt, this.peer.port, this.peer.address, () => r()));
    this.inflight.add(p);
    void p.then(() => this.inflight.delete(p));
  }

  /** Envía `pkt` y espera un mensaje que cumpla `accept`; reintenta si vence el plazo. */
  async exchange(pkt: Buffer | null, accept: (msg: Buffer) => boolean): Promise<Buffer> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.closed) throw new Error('canal cerrado');
      if (pkt) this.send(pkt);
      const got = await new Promise<Buffer | null>((resolve) => {
        const t = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, this.timeoutMs);
        this.waiter = (m) => {
          if (m.length >= 2 && m.readUInt16BE(0) === OP.ERROR) {
            clearTimeout(t);
            resolve(m);
            return true;
          }
          if (accept(m)) {
            clearTimeout(t);
            return true;
          }
          return false;
        };
        this.resolveWait = (m) => resolve(m);
      });
      if (got) {
        if (got.readUInt16BE(0) === OP.ERROR) throw new Error(`el cliente abortó: ${got.subarray(4).toString('latin1').replace(/\0.*/, '')}`);
        return got;
      }
    }
    throw new Error('tiempo de espera agotado');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.inflight);
    try {
      this.sock.close();
    } catch {
      /* ya cerrado */
    }
  }
}

export class TftpServer extends BuiltinServer {
  private sock: Socket | null = null;
  private channels = new Set<Channel>();

  boundPort(): number | undefined {
    try {
      return this.sock?.address().port;
    } catch {
      return undefined;
    }
  }

  async start(): Promise<void> {
    await fs.mkdir(this.cfg.rootDir, { recursive: true });
    const sock = createSocket({ type: this.cfg.bindHost.includes(':') ? 'udp6' : 'udp4', reuseAddr: false });
    await new Promise<void>((resolve, reject) => {
      sock.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      sock.bind(this.cfg.port, this.cfg.bindHost || '0.0.0.0', () => resolve());
    });
    sock.on('error', (e) => this.log('error', e.message));
    sock.on('message', (msg, rinfo) => void this.onRequest(msg, rinfo));
    this.sock = sock;
    this.running = true;
    this.log('info', `TFTP escuchando en ${this.cfg.bindHost || '0.0.0.0'}:${this.boundPort()} · raíz ${this.cfg.rootDir}${this.cfg.allowWrite ? ' · escritura permitida' : ''}`);
    this.changed();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.channels].map((c) => c.close()));
    this.channels.clear();
    await new Promise<void>((r) => (this.sock ? this.sock.close(() => r()) : r()));
    this.sock = null;
    this.running = false;
    this.log('info', 'TFTP detenido');
    this.changed();
  }

  private async onRequest(msg: Buffer, rinfo: RemoteInfo): Promise<void> {
    const req = parseRequest(msg);
    const reply = (pkt: Buffer) => this.sock?.send(pkt, rinfo.port, rinfo.address);
    if (!req) return void reply(errorPacket(ERR.ILLEGAL, 'Petición no válida'));
    const who = `${rinfo.address}:${rinfo.port}`;
    const path = safeResolve(this.cfg.rootDir, req.filename);
    if (!path) {
      this.log('warn', `${who} intentó acceder fuera de la carpeta raíz: ${req.filename}`);
      return void reply(errorPacket(ERR.ACCESS, 'Acceso denegado'));
    }
    if (req.op === OP.WRQ && !this.cfg.allowWrite) {
      this.log('warn', `${who} intentó subir ${req.filename} (escritura deshabilitada)`);
      return void reply(errorPacket(ERR.ACCESS, 'Escritura deshabilitada'));
    }

    // Negociación de opciones.
    const opts: Record<string, string> = {};
    let blksize = 512;
    let timeoutMs = 3000;
    if (req.options.blksize) {
      const b = Math.max(8, Math.min(65464, Number(req.options.blksize) || 512));
      blksize = b;
      opts.blksize = String(b);
    }
    if (req.options.timeout) {
      const t = Math.max(1, Math.min(255, Number(req.options.timeout) || 3));
      timeoutMs = t * 1000;
      opts.timeout = String(t);
    }

    const ch = new Channel(rinfo, timeoutMs);
    this.channels.add(ch);
    await ch.bind();
    const started = Date.now();
    const op = req.op === OP.RRQ ? 'descarga' : 'subida';
    this.log('transfer', `${who} inicia ${op} de ${req.filename}${blksize !== 512 ? ` (blksize ${blksize})` : ''}`);
    try {
      const bytes = await this.track(req.op === OP.RRQ ? this.sendFile(ch, path, req, opts, blksize) : this.receiveFile(ch, path, req, opts, blksize));
      const secs = Math.max((Date.now() - started) / 1000, 0.001);
      this.log('transfer', `${who} ${op} completada: ${req.filename} · ${bytes} bytes en ${secs.toFixed(1)} s (${Math.round(bytes / 1024 / secs)} KB/s)`);
    } catch (e) {
      this.log('error', `${who} ${op} de ${req.filename} fallida: ${(e as Error).message}`);
    } finally {
      await ch.close();
      this.channels.delete(ch);
    }
  }

  private async sendFile(ch: Channel, path: string, req: TftpRequest, opts: Record<string, string>, blksize: number): Promise<number> {
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(path, 'r');
    } catch {
      ch.send(errorPacket(ERR.NOT_FOUND, 'Archivo no encontrado'));
      throw new Error('archivo no encontrado');
    }
    try {
      const size = (await fh.stat()).size;
      if (req.options.tsize !== undefined) opts.tsize = String(size);
      if (Object.keys(opts).length) {
        // Tras OACK el cliente confirma con ACK 0.
        await ch.exchange(oackPacket(opts), (m) => m.readUInt16BE(0) === OP.ACK && m.readUInt16BE(2) === 0);
      }
      let block = 1;
      let offset = 0;
      const buf = Buffer.alloc(blksize);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, blksize, offset);
        const pkt = Buffer.alloc(4 + bytesRead);
        pkt.writeUInt16BE(OP.DATA, 0);
        pkt.writeUInt16BE(block & 0xffff, 2);
        buf.copy(pkt, 4, 0, bytesRead);
        const expected = block & 0xffff;
        await ch.exchange(pkt, (m) => m.readUInt16BE(0) === OP.ACK && m.readUInt16BE(2) === expected);
        offset += bytesRead;
        if (bytesRead < blksize) return offset;
        block++;
      }
    } finally {
      await fh.close();
    }
  }

  private async receiveFile(ch: Channel, path: string, req: TftpRequest, opts: Record<string, string>, blksize: number): Promise<number> {
    await fs.mkdir(dirname(path), { recursive: true });
    if (req.options.tsize !== undefined) opts.tsize = req.options.tsize;
    const tmp = join(dirname(path), `.${basename(path)}.nexus-part`);
    const fh = await fs.open(tmp, 'w');
    let total = 0;
    let ok = false;
    try {
      let block = 1;
      let pkt: Buffer = Object.keys(opts).length ? oackPacket(opts) : ack(0);
      for (;;) {
        const expected = block & 0xffff;
        const data = await ch.exchange(pkt, (m) => m.readUInt16BE(0) === OP.DATA && m.readUInt16BE(2) === expected);
        const payload = data.subarray(4);
        await fh.write(payload, 0, payload.length, total);
        total += payload.length;
        pkt = ack(block);
        if (payload.length < blksize) {
          ch.send(pkt);
          break;
        }
        block++;
      }
      ok = true;
    } finally {
      await fh.close();
      if (ok) await fs.rename(tmp, path);
      else await fs.rm(tmp, { force: true });
    }
    return total;
  }
}
