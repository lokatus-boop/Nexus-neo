// Servidor FTP (RFC 959 + EPSV/EPRT, SIZE, MDTM, FEAT, UTF8) para copiar firmware y configuraciones.
import { createServer, connect, Server, Socket, AddressInfo } from 'node:net';
import { createReadStream, createWriteStream, promises as fs, Stats } from 'node:fs';
import { posix, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { BuiltinServer, safeResolve, friendlyListenError } from './common';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function listLine(name: string, st: Stats): string {
  const d = new Date(st.mtimeMs);
  const recent = Date.now() - st.mtimeMs < 180 * 86400_000;
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`}`;
  const perms = st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
  return `${perms} 1 owner group ${String(st.size).padStart(12, ' ')} ${when} ${name}`;
}

function mdtm(st: Stats): string {
  return new Date(st.mtimeMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

class FtpSession {
  private cwd = '/';
  private user = '';
  private authed = false;
  private pasv: Server | null = null;
  private pasvSocket: Promise<Socket> | null = null;
  private active: { host: string; port: number } | null = null;
  private renameFrom: string | null = null;
  private restOffset = 0;
  private buf = '';
  private queue: Promise<void> = Promise.resolve();
  private readonly who: string;

  constructor(private readonly sock: Socket, private readonly srv: FtpServer) {
    this.who = `${sock.remoteAddress}:${sock.remotePort}`;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        this.queue = this.queue.then(() => this.handle(line)).catch(() => undefined);
      }
      if (this.buf.length > 8192) sock.destroy();
    });
    sock.on('error', () => undefined);
    sock.on('close', () => this.closePasv());
    this.reply(220, 'Nexus Neo FTP listo');
  }

  private reply(code: number, msg: string): void {
    if (!this.sock.destroyed) this.sock.write(`${code} ${msg}\r\n`);
  }

  private resolve(arg: string): { virt: string; real: string } | null {
    const virt = posix.normalize(posix.isAbsolute(arg) ? arg : posix.join(this.cwd, arg || '.'));
    const real = safeResolve(this.srv.cfg.rootDir, virt);
    return real ? { virt: virt === '.' ? '/' : virt, real } : null;
  }

  private closePasv(): void {
    this.pasv?.close();
    this.pasv = null;
    this.pasvSocket = null;
  }

  private async openPasv(): Promise<number> {
    this.closePasv();
    this.active = null;
    const { pasvMin = 50000, pasvMax = 50100 } = this.srv.cfg;
    const server = createServer();
    this.pasvSocket = new Promise<Socket>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 30000);
      server.once('connection', (s) => {
        clearTimeout(t);
        // Sólo aceptamos la conexión de datos desde la misma IP del control.
        if (s.remoteAddress !== this.sock.remoteAddress) {
          s.destroy();
          return reject(new Error('conexión de datos desde otra IP'));
        }
        resolve(s);
        server.close();
      });
    });
    this.pasvSocket.catch(() => undefined);
    for (let port = pasvMin; port <= pasvMax; port++) {
      const ok = await new Promise<boolean>((r) => {
        server.once('error', () => r(false));
        server.listen(port, this.sock.localAddress, () => r(true));
      });
      if (ok) {
        this.pasv = server;
        return (server.address() as AddressInfo).port;
      }
    }
    throw new Error('no hay puertos pasivos libres');
  }

  private async dataSocket(): Promise<Socket> {
    if (this.active) {
      const { host, port } = this.active;
      this.active = null;
      return new Promise((resolve, reject) => {
        const s = connect(port, host, () => resolve(s));
        s.once('error', reject);
      });
    }
    if (!this.pasvSocket) throw new Error('usa PASV o PORT primero');
    const s = await this.pasvSocket;
    this.pasvSocket = null;
    return s;
  }

  private async withData(fn: (s: Socket) => Promise<void>): Promise<void> {
    let s: Socket;
    try {
      s = await this.dataSocket();
    } catch (e) {
      return this.reply(425, `No se pudo abrir la conexión de datos: ${(e as Error).message}`);
    }
    this.reply(150, 'Abriendo conexión de datos');
    try {
      await fn(s);
      this.reply(226, 'Transferencia completada');
    } catch (e) {
      s.destroy();
      this.reply(451, `Error: ${(e as Error).message}`);
    } finally {
      this.closePasv();
    }
  }

  private async handle(line: string): Promise<void> {
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1);
    const cfg = this.srv.cfg;
    const open = ['USER', 'PASS', 'QUIT', 'FEAT', 'SYST', 'NOOP', 'OPTS', 'AUTH'];
    if (!this.authed && !open.includes(cmd)) return this.reply(530, 'Inicia sesión primero');
    try {
      switch (cmd) {
        case 'USER':
          this.user = arg;
          if (cfg.anonymous && /^(anonymous|ftp)$/i.test(arg)) return this.reply(331, 'Anónimo: introduce cualquier contraseña');
          return this.reply(331, 'Contraseña requerida');
        case 'PASS': {
          const anon = cfg.anonymous && /^(anonymous|ftp)$/i.test(this.user);
          if (anon || (cfg.username && safeEq(this.user, cfg.username) && safeEq(arg, cfg.password || ''))) {
            this.authed = true;
            this.srv.note('info', `${this.who} inició sesión como ${this.user || 'anonymous'}`);
            return this.reply(230, 'Sesión iniciada');
          }
          this.srv.note('warn', `${this.who} credenciales incorrectas para "${this.user}"`);
          await new Promise((r) => setTimeout(r, 1000));
          return this.reply(530, 'Credenciales incorrectas');
        }
        case 'AUTH':
          return this.reply(502, 'TLS no soportado');
        case 'SYST':
          return this.reply(215, 'UNIX Type: L8');
        case 'FEAT':
          this.sock.write('211-Extensiones:\r\n EPSV\r\n EPRT\r\n PASV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n UTF8\r\n211 Fin\r\n');
          return;
        case 'OPTS':
          return this.reply(200, 'OK');
        case 'NOOP':
          return this.reply(200, 'OK');
        case 'QUIT':
          this.reply(221, 'Adiós');
          return void this.sock.end();
        case 'PWD':
        case 'XPWD':
          return this.reply(257, `"${this.cwd}" es el directorio actual`);
        case 'CWD':
        case 'XCWD':
        case 'CDUP': {
          const p = this.resolve(cmd === 'CDUP' ? '..' : arg);
          if (!p) return this.reply(550, 'Acceso denegado');
          const st = await fs.stat(p.real).catch(() => null);
          if (!st?.isDirectory()) return this.reply(550, 'No es un directorio');
          this.cwd = p.virt;
          return this.reply(250, `Directorio cambiado a ${this.cwd}`);
        }
        case 'TYPE':
        case 'MODE':
        case 'STRU':
          return this.reply(200, 'OK');
        case 'PASV': {
          const port = await this.openPasv();
          const ip = (this.sock.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return this.reply(522, 'Usa EPSV en IPv6');
          return this.reply(227, `Modo pasivo (${ip.split('.').join(',')},${port >> 8},${port & 0xff})`);
        }
        case 'EPSV': {
          const port = await this.openPasv();
          return this.reply(229, `Modo pasivo extendido (|||${port}|)`);
        }
        case 'PORT': {
          const n = arg.split(',').map(Number);
          if (n.length !== 6 || n.some((x) => !(x >= 0 && x <= 255))) return this.reply(501, 'Parámetros no válidos');
          const host = n.slice(0, 4).join('.');
          if (host !== this.sock.remoteAddress?.replace(/^::ffff:/, '')) return this.reply(504, 'PORT sólo hacia la IP del cliente');
          this.closePasv();
          this.active = { host, port: n[4] * 256 + n[5] };
          return this.reply(200, 'PORT aceptado');
        }
        case 'EPRT': {
          const parts = arg.split(arg[0]);
          const host = parts[2];
          const port = Number(parts[3]);
          if (!host || !port) return this.reply(501, 'Parámetros no válidos');
          this.closePasv();
          this.active = { host, port };
          return this.reply(200, 'EPRT aceptado');
        }
        case 'LIST':
        case 'NLST': {
          const target = this.resolve(arg.replace(/^-\S+\s*/, ''));
          if (!target) return this.reply(550, 'Acceso denegado');
          const st = await fs.stat(target.real).catch(() => null);
          if (!st) return this.reply(550, 'No existe');
          let lines: string[];
          if (st.isDirectory()) {
            const names = (await fs.readdir(target.real)).filter((n) => !n.endsWith('.nexus-part'));
            lines = [];
            for (const n of names) {
              const s = await fs.stat(join(target.real, n)).catch(() => null);
              if (s) lines.push(cmd === 'LIST' ? listLine(n, s) : n);
            }
          } else lines = [cmd === 'LIST' ? listLine(posix.basename(target.virt), st) : posix.basename(target.virt)];
          return this.withData(async (s) => {
            await new Promise<void>((r) => s.end(lines.map((l) => l + '\r\n').join(''), () => r()));
          });
        }
        case 'SIZE':
        case 'MDTM': {
          const p = this.resolve(arg);
          const st = p ? await fs.stat(p.real).catch(() => null) : null;
          if (!st?.isFile()) return this.reply(550, 'No existe');
          return this.reply(213, cmd === 'SIZE' ? String(st.size) : mdtm(st));
        }
        case 'REST':
          this.restOffset = Math.max(0, Number(arg) || 0);
          return this.reply(350, `Reanudando en ${this.restOffset}`);
        case 'RETR': {
          const p = this.resolve(arg);
          const st = p ? await fs.stat(p.real).catch(() => null) : null;
          if (!p || !st?.isFile()) return this.reply(550, 'Archivo no encontrado');
          const start = this.restOffset;
          this.restOffset = 0;
          const t0 = Date.now();
          return this.withData((s) =>
            this.srv.trackTransfer(pipeline(createReadStream(p.real, { start }), s)).then(() =>
              this.srv.note('transfer', `${this.who} descargó ${p.virt} (${st.size - start} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`)));
        }
        case 'STOR':
        case 'APPE': {
          if (!cfg.allowWrite) return this.reply(550, 'Escritura deshabilitada');
          const p = this.resolve(arg);
          if (!p) return this.reply(550, 'Acceso denegado');
          const append = cmd === 'APPE';
          const t0 = Date.now();
          return this.withData(async (s) => {
            await this.srv.trackTransfer(pipeline(s, createWriteStream(p.real, { flags: append ? 'a' : 'w' })));
            const size = (await fs.stat(p.real)).size;
            this.srv.note('transfer', `${this.who} subió ${p.virt} (${size} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
          });
        }
        case 'DELE':
        case 'RMD':
        case 'XRMD':
        case 'MKD':
        case 'XMKD': {
          if (!cfg.allowWrite) return this.reply(550, 'Escritura deshabilitada');
          const p = this.resolve(arg);
          if (!p || p.virt === '/') return this.reply(550, 'Acceso denegado');
          if (cmd === 'DELE') await fs.unlink(p.real);
          else if (cmd.endsWith('RMD')) await fs.rmdir(p.real);
          else {
            await fs.mkdir(p.real);
            return this.reply(257, `"${p.virt}" creado`);
          }
          this.srv.note('info', `${this.who} ${cmd} ${p.virt}`);
          return this.reply(250, 'OK');
        }
        case 'RNFR': {
          if (!cfg.allowWrite) return this.reply(550, 'Escritura deshabilitada');
          const p = this.resolve(arg);
          if (!p) return this.reply(550, 'Acceso denegado');
          this.renameFrom = p.real;
          return this.reply(350, 'Esperando RNTO');
        }
        case 'RNTO': {
          const p = this.resolve(arg);
          if (!p || !this.renameFrom) return this.reply(503, 'Usa RNFR primero');
          await fs.rename(this.renameFrom, p.real);
          this.renameFrom = null;
          return this.reply(250, 'Renombrado');
        }
        default:
          return this.reply(502, 'Comando no implementado');
      }
    } catch (e) {
      this.reply(550, (e as Error).message);
    }
  }
}

export class FtpServer extends BuiltinServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  boundPort(): number | undefined {
    return (this.server?.address() as AddressInfo | null)?.port;
  }

  note(level: 'info' | 'warn' | 'transfer', msg: string): void {
    this.log(level, msg);
  }

  trackTransfer<T>(p: Promise<T>): Promise<T> {
    return this.track(p);
  }

  async start(): Promise<void> {
    if (!this.cfg.anonymous && !this.cfg.username) throw new Error('Configura un usuario o activa el acceso anónimo.');
    await fs.mkdir(this.cfg.rootDir, { recursive: true });
    const server = createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      this.log('info', `${sock.remoteAddress}:${sock.remotePort} conectado`);
      new FtpSession(sock, this);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      server.listen(this.cfg.port, this.cfg.bindHost || '0.0.0.0', () => resolve());
    });
    this.server = server;
    this.running = true;
    this.log('info', `FTP escuchando en ${this.cfg.bindHost || '0.0.0.0'}:${this.boundPort()} · raíz ${this.cfg.rootDir} · pasivo ${this.cfg.pasvMin ?? 50000}-${this.cfg.pasvMax ?? 50100}`);
    this.changed();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.running = false;
    this.log('info', 'FTP detenido');
    this.changed();
  }
}
