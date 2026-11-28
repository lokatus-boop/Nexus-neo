// Servidor SSH de archivos: SFTP (subsistema «sftp») y SCP clásico («scp -t» / «scp -f») sobre la
// misma conexión. Sólo transfiere archivos dentro de la carpeta raíz: no hay shell ni reenvíos.
import { Server, Connection, utils, ParsedKey, SFTPWrapper, ServerChannel, AuthContext } from 'ssh2';
import { promises as fs, constants as FS, Stats, createReadStream } from 'node:fs';
import { AddressInfo, Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join, posix, dirname, basename } from 'node:path';
import { BuiltinServer, safeResolve, friendlyListenError } from './common';
import { generateKeyPairChecked } from '../keys';

const STATUS = utils.sftp.STATUS_CODE;
const OPEN = utils.sftp.OPEN_MODE;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Normaliza una ruta de cliente a una ruta virtual absoluta («/» es la carpeta raíz). */
export function virtualPath(p: string, cwd = '/'): string {
  const joined = posix.resolve(cwd, (p || '.').replace(/\\/g, '/'));
  return joined === '' ? '/' : joined;
}

/** Divide una orden en palabras respetando comillas simples, dobles y barras invertidas. */
export function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface ScpCommand {
  mode: 'sink' | 'source';
  recursive: boolean;
  preserve: boolean;
  targetIsDir: boolean;
  paths: string[];
}

export function parseScpCommand(cmd: string): ScpCommand | null {
  const words = shellSplit(cmd);
  if (!words.length || basename(words[0]) !== 'scp') return null;
  const r: ScpCommand = { mode: 'sink', recursive: false, preserve: false, targetIsDir: false, paths: [] };
  let mode: ScpCommand['mode'] | null = null;
  let opts = true;
  for (const w of words.slice(1)) {
    if (opts && w === '--') opts = false;
    else if (opts && w.startsWith('-') && w.length > 1) {
      for (const f of w.slice(1)) {
        if (f === 't') mode = 'sink';
        else if (f === 'f') mode = 'source';
        else if (f === 'r') r.recursive = true;
        else if (f === 'p') r.preserve = true;
        else if (f === 'd') r.targetIsDir = true;
        // -v, -q y demás no cambian nada aquí.
      }
    } else r.paths.push(w);
  }
  if (!mode || !r.paths.length) return null;
  r.mode = mode;
  return r;
}

function modeString(st: Stats): string {
  const t = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += st.mode & (1 << (8 - i)) ? bits[i] : '-';
  return t + s;
}

function longname(name: string, st: Stats): string {
  const d = st.mtime;
  const recent = Date.now() - d.getTime() < 180 * 86400 * 1000;
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : String(d.getFullYear()).padStart(5)}`;
  return `${modeString(st)} 1 nexus nexus ${String(st.size).padStart(12)} ${when} ${name}`;
}

function attrs(st: Stats) {
  return { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function errStatus(e: unknown): number {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EEXIST') return STATUS.PERMISSION_DENIED;
  return STATUS.FAILURE;
}

function openFlags(f: number): number {
  let flags = f & OPEN.READ && f & OPEN.WRITE ? FS.O_RDWR : f & OPEN.WRITE ? FS.O_WRONLY : FS.O_RDONLY;
  if (f & OPEN.APPEND) flags |= FS.O_APPEND;
  if (f & OPEN.CREAT) flags |= FS.O_CREAT;
  if (f & OPEN.TRUNC) flags |= FS.O_TRUNC;
  if (f & OPEN.EXCL) flags |= FS.O_EXCL;
  return flags;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();

/** Lector secuencial de un canal SSH: líneas de control y bloques binarios de SCP. */
class ChannelReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private ended = false;

  constructor(stream: ServerChannel) {
    stream.on('data', (d: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.wake();
    });
    stream.on('end', () => {
      this.ended = true;
      this.wake();
    });
    stream.on('close', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private async need(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      if (this.ended) return false;
      await new Promise<void>((r) => (this.waiting = r));
    }
    return true;
  }

  async byte(): Promise<number | null> {
    if (!(await this.need(1))) return null;
    const b = this.buf[0];
    this.buf = this.buf.subarray(1);
    return b;
  }

  async line(): Promise<string | null> {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 1);
        return l;
      }
      if (this.buf.length > 64 * 1024) throw new Error('línea de control demasiado larga');
      if (!(await this.need(this.buf.length + 1))) return null;
    }
  }

  /** Entrega exactamente `n` bytes por trozos a `sink`. */
  async chunks(n: number, sink: (b: Buffer) => Promise<void>): Promise<void> {
    let left = n;
    while (left > 0) {
      if (!(await this.need(1))) throw new Error('conexión cerrada a mitad del archivo');
      const take = Math.min(left, this.buf.length);
      const part = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      await sink(part);
    }
  }
}

interface FileHandle {
  kind: 'file';
  fh: fs.FileHandle;
  vpath: string;
  write: boolean;
  bytes: number;
  started: number;
}
interface DirHandle {
  kind: 'dir';
  vpath: string;
  real: string;
  entries: string[] | null;
}

export class SftpServer extends BuiltinServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private keys: ParsedKey[] = [];
  hostFingerprint = '';

  boundPort(): number | undefined {
    return (this.server?.address() as AddressInfo | null)?.port;
  }

  private async hostKey(): Promise<string> {
    const path = join(this.stateDir, 'sftp_host_ed25519_key');
    try {
      const k = await fs.readFile(path, 'utf8');
      if (!(utils.parseKey(k) instanceof Error)) return k;
    } catch {
      /* se genera */
    }
    const pair = generateKeyPairChecked('ed25519', { comment: 'nexus-neo-sftp' });
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(path, pair.private, { mode: 0o600 });
    await fs.writeFile(`${path}.pub`, pair.public + '\n');
    return pair.private;
  }

  private loadAuthorizedKeys(): void {
    this.keys = [];
    for (const line of (this.cfg.authorizedKeys || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parsed = utils.parseKey(t);
      if (parsed instanceof Error) throw new Error(`Clave pública no válida: ${t.slice(0, 40)}…`);
      this.keys.push(Array.isArray(parsed) ? parsed[0] : parsed);
    }
  }

  async start(): Promise<void> {
    await fs.mkdir(this.cfg.rootDir, { recursive: true });
    if (!this.cfg.username) throw new Error('Indica un usuario para el servidor SFTP/SCP.');
    this.loadAuthorizedKeys();
    if (!this.cfg.password && !this.keys.length) throw new Error('Define una contraseña o al menos una clave pública autorizada.');
    const key = await this.hostKey();
    const parsed = utils.parseKey(key) as ParsedKey;
    this.hostFingerprint = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
    const server = new Server({ hostKeys: [key], ident: 'NexusNeo' }, (client, info) => this.onClient(client, info.ip.replace(/^::ffff:/, '')));
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: Error) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      server.listen(this.cfg.port, this.cfg.bindHost || '0.0.0.0', () => resolve());
    });
    // ssh2 no expone los sockets: se recogen del net.Server interno para poder cortar al detener.
    const net = (server as unknown as { _srv: import('node:net').Server })._srv;
    net?.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    server.on('error', (e: Error) => this.log('error', e.message));
    this.server = server;
    this.running = true;
    const auth = [this.cfg.password ? 'contraseña' : '', this.keys.length ? `${this.keys.length} clave(s)` : ''].filter(Boolean).join(' + ');
    this.log('info', `SFTP/SCP escuchando en ${this.cfg.bindHost || '0.0.0.0'}:${this.boundPort()} · usuario ${this.cfg.username} (${auth}) · raíz ${this.cfg.rootDir}${this.cfg.allowWrite ? ' · escritura permitida' : ' · sólo lectura'} · huella del host ${this.hostFingerprint}`);
    this.changed();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.running = false;
    this.log('info', 'SFTP/SCP detenido');
    this.changed();
  }

  private checkAuth(ctx: AuthContext): boolean {
    if (ctx.username !== this.cfg.username) return false;
    if (ctx.method === 'password') {
      return !!this.cfg.password && timingSafeEqual(sha(ctx.password), sha(this.cfg.password));
    }
    if (ctx.method === 'publickey') {
      const k = this.keys.find((a) => a.type === ctx.key.algo && a.getPublicSSH().equals(ctx.key.data));
      if (!k) return false;
      // Sin firma es sólo una consulta: se acepta para que el cliente firme después.
      if (!ctx.signature) return true;
      return k.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true;
    }
    return false;
  }

  private onClient(client: Connection, ip: string): void {
    let user = '';
    let failures = 0;
    client.on('authentication', (ctx) => {
      const methods = [...(this.cfg.password ? ['password' as const] : []), ...(this.keys.length ? ['publickey' as const] : [])];
      if ((ctx.method === 'password' || ctx.method === 'publickey') && this.checkAuth(ctx)) {
        if (ctx.method === 'publickey' && !ctx.signature) return ctx.accept();
        user = ctx.username;
        return ctx.accept();
      }
      if (ctx.method !== 'none') {
        failures++;
        this.log('warn', `${ip}: autenticación fallida para «${ctx.username}» (${ctx.method})`);
      }
      if (failures >= 6) return client.end();
      ctx.reject(methods);
    });
    client.on('ready', () => {
      this.log('info', `${ip}: ${user} conectado`);
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acc) => this.serveSftp(acc(), ip));
        session.on('exec', (acc, rej, info) => {
          const scp = parseScpCommand(info.command);
          if (!scp) {
            this.log('warn', `${ip}: orden no permitida: ${info.command}`);
            const ch = acc();
            ch.stderr.write('Nexus Neo: este servidor sólo admite SFTP y SCP.\n');
            ch.exit(1);
            ch.end();
            return;
          }
          const ch = acc();
          void this.track(this.runScp(ch, scp, ip)).then(
            (code) => {
              ch.exit(code);
              ch.end();
            },
            (e) => {
              this.log('error', `${ip}: SCP: ${(e as Error).message}`);
              ch.exit(1);
              ch.end();
            },
          );
        });
        session.on('shell', (acc) => {
          const ch = acc();
          ch.write('Nexus Neo: este servidor sólo admite SFTP y SCP.\r\n');
          ch.exit(1);
          ch.end();
        });
        session.on('pty', (acc) => acc?.());
        session.on('env', (acc) => acc?.());
      });
      client.on('tcpip', (_a, reject) => reject());
      client.on('request', (_a, reject) => reject?.());
    });
    client.on('error', () => undefined);
    client.on('close', () => user && this.log('info', `${ip}: ${user} desconectado`));
  }

  private real(vpath: string): string | null {
    return safeResolve(this.cfg.rootDir, vpath);
  }

  // ----------------------------------------------------------------- SFTP
  private serveSftp(sftp: SFTPWrapper, ip: string): void {
    const handles = new Map<number, FileHandle | DirHandle>();
    let next = 1;
    const newHandle = (h: FileHandle | DirHandle): Buffer => {
      const id = next++;
      handles.set(id, h);
      const b = Buffer.alloc(4);
      b.writeUInt32BE(id);
      return b;
    };
    const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
    const resolveReq = (reqid: number, p: string): { vpath: string; real: string } | null => {
      const vpath = virtualPath(p);
      const real = this.real(vpath);
      if (!real) {
        this.log('warn', `${ip}: intentó salir de la carpeta raíz: ${p}`);
        sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Acceso denegado');
        return null;
      }
      return { vpath, real };
    };
    const denyWrite = (reqid: number, what: string): boolean => {
      if (this.cfg.allowWrite) return false;
      this.log('warn', `${ip}: ${what} rechazado (sólo lectura)`);
      sftp.status(reqid, STATUS.PERMISSION_DENIED, 'Servidor de sólo lectura');
      return true;
    };
    const fail = (reqid: number, e: unknown) => sftp.status(reqid, errStatus(e), (e as Error).message);

    sftp.on('REALPATH', (reqid, p) => {
      const vpath = virtualPath(p);
      sftp.name(reqid, [{ filename: vpath, longname: vpath, attrs: {} as never }]);
    });
    const doStat = (reqid: number, p: string, lstat: boolean) => {
      const r = resolveReq(reqid, p);
      if (!r) return;
      (lstat ? fs.lstat(r.real) : fs.stat(r.real)).then((st) => sftp.attrs(reqid, attrs(st)), (e) => fail(reqid, e));
    };
    sftp.on('STAT', (reqid, p) => doStat(reqid, p, false));
    sftp.on('LSTAT', (reqid, p) => doStat(reqid, p, true));
    sftp.on('FSTAT', (reqid, handle) => {
      const h = getHandle(handle);
      if (!h) return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      (h.kind === 'file' ? h.fh.stat() : fs.stat(h.real)).then((st) => sftp.attrs(reqid, attrs(st)), (e) => fail(reqid, e));
    });
    sftp.on('OPEN', (reqid, filename, flags) => {
      const r = resolveReq(reqid, filename);
      if (!r) return;
      const write = !!(flags & (OPEN.WRITE | OPEN.APPEND | OPEN.CREAT | OPEN.TRUNC));
      if (write && denyWrite(reqid, `subida de ${r.vpath}`)) return;
      void (async () => {
        try {
          if (write) await fs.mkdir(dirname(r.real), { recursive: true });
          const fh = await fs.open(r.real, openFlags(flags), 0o644);
          if (!write && (await fh.stat()).isDirectory()) {
            await fh.close();
            return sftp.status(reqid, STATUS.FAILURE, 'Es una carpeta');
          }
          this.active++;
          this.changed();
          sftp.handle(reqid, newHandle({ kind: 'file', fh, vpath: r.vpath, write, bytes: 0, started: Date.now() }));
        } catch (e) {
          fail(reqid, e);
        }
      })();
    });
    sftp.on('READ', (reqid, handle, offset, length) => {
      const h = getHandle(handle);
      if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      const buf = Buffer.alloc(Math.min(length, 256 * 1024));
      h.fh.read(buf, 0, buf.length, offset).then(({ bytesRead }) => {
        if (!bytesRead) return sftp.status(reqid, STATUS.EOF);
        h.bytes += bytesRead;
        sftp.data(reqid, buf.subarray(0, bytesRead));
      }, (e) => fail(reqid, e));
    });
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const h = getHandle(handle);
      if (!h || h.kind !== 'file' || !h.write) return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      h.fh.write(data, 0, data.length, offset).then(() => {
        h.bytes += data.length;
        sftp.status(reqid, STATUS.OK);
      }, (e) => fail(reqid, e));
    });
    sftp.on('CLOSE', (reqid, handle) => {
      const h = getHandle(handle);
      if (!h) return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      handles.delete(handle.readUInt32BE(0));
      if (h.kind === 'dir') return sftp.status(reqid, STATUS.OK);
      this.active--;
      this.changed();
      h.fh.close().then(() => {
        if (h.bytes || h.write) {
          const secs = Math.max((Date.now() - h.started) / 1000, 0.001);
          this.log('transfer', `${ip} ${h.write ? 'subió' : 'descargó'} ${h.vpath} por SFTP (${h.bytes} bytes, ${secs.toFixed(1)} s)`);
        }
        sftp.status(reqid, STATUS.OK);
      }, (e) => fail(reqid, e));
    });
    sftp.on('OPENDIR', (reqid, p) => {
      const r = resolveReq(reqid, p);
      if (!r) return;
      fs.stat(r.real).then((st) => {
        if (!st.isDirectory()) return sftp.status(reqid, STATUS.NO_SUCH_FILE, 'No es una carpeta');
        sftp.handle(reqid, newHandle({ kind: 'dir', vpath: r.vpath, real: r.real, entries: null }));
      }, (e) => fail(reqid, e));
    });
    sftp.on('READDIR', (reqid, handle) => {
      const h = getHandle(handle);
      if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      void (async () => {
        try {
          if (!h.entries) h.entries = ['.', '..', ...(await fs.readdir(h.real)).sort()];
          if (!h.entries.length) return sftp.status(reqid, STATUS.EOF);
          const batch = h.entries.splice(0, 100);
          const names = [];
          for (const n of batch) {
            const st = await fs.lstat(n === '..' && h.vpath === '/' ? h.real : join(h.real, n)).catch(() => null);
            if (st) names.push({ filename: n, longname: longname(n, st), attrs: attrs(st) });
          }
          sftp.name(reqid, names);
        } catch (e) {
          fail(reqid, e);
        }
      })();
    });
    const mutate = (reqid: number, p: string, what: string, op: (real: string, vpath: string) => Promise<unknown>, msg?: (vpath: string) => string) => {
      const r = resolveReq(reqid, p);
      if (!r || denyWrite(reqid, what)) return;
      if (r.vpath === '/') return sftp.status(reqid, STATUS.PERMISSION_DENIED, 'No se puede modificar la raíz');
      op(r.real, r.vpath).then(() => {
        this.log('transfer', `${ip}: ${msg ? msg(r.vpath) : `${what} ${r.vpath}`}`);
        sftp.status(reqid, STATUS.OK);
      }, (e) => fail(reqid, e));
    };
    sftp.on('REMOVE', (reqid, p) => mutate(reqid, p, 'borró', (real) => fs.unlink(real)));
    sftp.on('RMDIR', (reqid, p) => mutate(reqid, p, 'borró la carpeta', (real) => fs.rmdir(real)));
    sftp.on('MKDIR', (reqid, p) => mutate(reqid, p, 'creó la carpeta', (real) => fs.mkdir(real)));
    sftp.on('RENAME', (reqid, from, to) => {
      const dst = resolveReq(reqid, to);
      if (!dst) return;
      mutate(reqid, from, 'renombrado', async (real) => {
        if (await fs.stat(dst.real).then(() => true, () => false)) throw Object.assign(new Error('El destino ya existe'), { code: 'EEXIST' });
        await fs.rename(real, dst.real);
      }, (v) => `renombró ${v} a ${dst.vpath}`);
    });
    const setstat = (reqid: number, real: string | null, a: { atime?: number; mtime?: number; mode?: number }) => {
      if (!real) return;
      if (!this.cfg.allowWrite) return sftp.status(reqid, STATUS.OK);
      void (async () => {
        try {
          if (a.mtime !== undefined) await fs.utimes(real, a.atime ?? a.mtime, a.mtime);
          if (a.mode !== undefined && process.platform !== 'win32') await fs.chmod(real, a.mode & 0o777);
          sftp.status(reqid, STATUS.OK);
        } catch (e) {
          fail(reqid, e);
        }
      })();
    };
    sftp.on('SETSTAT', (reqid, p, a) => setstat(reqid, resolveReq(reqid, p)?.real ?? null, a));
    sftp.on('FSETSTAT', (reqid, handle, a) => {
      const h = getHandle(handle);
      if (!h) return sftp.status(reqid, STATUS.FAILURE, 'Identificador no válido');
      setstat(reqid, h.kind === 'dir' ? h.real : this.real(h.vpath), a);
    });
    sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS.OP_UNSUPPORTED, 'No admitido'));
    sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS.OP_UNSUPPORTED, 'No admitido'));
    // El cliente cerró su lado (EOF): hay que cerrar el canal o OpenSSH se queda esperando.
    // Además se envía el código de salida 0, como sftp-server, para que «scp» termine sin error.
    sftp.on('end', () => {
      const raw = sftp as unknown as { _protocol?: { exitStatus(id: number, code: number): void; channelEOF(id: number): void }; outgoing?: { id: number; state: string } };
      try {
        if (raw._protocol && raw.outgoing?.state === 'open') {
          raw._protocol.exitStatus(raw.outgoing.id, 0);
          raw._protocol.channelEOF(raw.outgoing.id);
        }
      } catch {
        /* el canal ya no existe */
      }
      sftp.end();
    });
    sftp.on('close', async () => {
      for (const h of handles.values()) {
        if (h.kind === 'file') {
          this.active--;
          await h.fh.close().catch(() => undefined);
        }
      }
      handles.clear();
      this.changed();
    });
  }

  // ------------------------------------------------------------------ SCP
  private async runScp(ch: ServerChannel, cmd: ScpCommand, ip: string): Promise<number> {
    const rd = new ChannelReader(ch);
    const write = (b: Buffer | string) => new Promise<void>((r) => (ch.write(b) ? r() : ch.once('drain', () => r())));
    const fatal = async (msg: string) => {
      this.log('warn', `${ip}: SCP: ${msg}`);
      await write(`\x02scp: ${msg}\n`);
      return 1;
    };
    if (cmd.mode === 'sink') {
      if (!this.cfg.allowWrite) return fatal('servidor de sólo lectura');
      return this.scpSink(rd, write, cmd, ip);
    }
    return this.scpSource(rd, write, cmd, ip);
  }

  private async scpSink(rd: ChannelReader, write: (b: Buffer | string) => Promise<void>, cmd: ScpCommand, ip: string): Promise<number> {
    const target = virtualPath(cmd.paths[0]);
    const targetReal = this.real(target);
    if (!targetReal) {
      this.log('warn', `${ip}: SCP intentó salir de la carpeta raíz: ${cmd.paths[0]}`);
      await write('\x02scp: acceso denegado\n');
      return 1;
    }
    const targetIsDir = await fs.stat(targetReal).then((s) => s.isDirectory(), () => false);
    if (cmd.targetIsDir && !targetIsDir) {
      await write(`\x02scp: ${target}: no es una carpeta\n`);
      return 1;
    }
    const stack: string[] = [];
    let times: { mtime: number; atime: number } | null = null;
    let errors = 0;
    const destFor = (name: string): string => (stack.length ? join(stack[stack.length - 1], name) : targetIsDir ? join(targetReal, name) : targetReal);
    const badName = (n: string) => !n || n === '.' || n === '..' || /[/\\]/.test(n);
    await write('\0');
    for (;;) {
      const line = await rd.line();
      if (line === null) break;
      const type = line[0];
      const rest = line.slice(1);
      if (type === 'T') {
        const m = /^(\d+) \d+ (\d+) \d+$/.exec(rest);
        times = m ? { mtime: Number(m[1]), atime: Number(m[2]) } : null;
        await write('\0');
      } else if (type === 'C' || type === 'D') {
        const m = /^([0-7]{4}) (\d+) (.+)$/.exec(rest);
        if (!m || badName(m[3])) {
          await write(`\x02scp: nombre o cabecera no válidos\n`);
          return 1;
        }
        const dest = destFor(m[3]);
        const vdest = '/' + dest.slice(this.real('/')!.length).replace(/\\/g, '/').replace(/^\/+/, '');
        if (type === 'D') {
          if (!cmd.recursive) {
            await write('\x02scp: se recibió una carpeta sin -r\n');
            return 1;
          }
          await fs.mkdir(dest, { recursive: true });
          stack.push(dest);
          times = null;
          await write('\0');
          continue;
        }
        const size = Number(m[2]);
        const started = Date.now();
        await fs.mkdir(dirname(dest), { recursive: true });
        const tmp = join(dirname(dest), `.${basename(dest)}.nexus-part`);
        let fh: fs.FileHandle | null = null;
        try {
          fh = await fs.open(tmp, 'w', parseInt(m[1], 8) & 0o777);
        } catch (e) {
          errors++;
          await write(`\x01scp: ${vdest}: ${(e as Error).message}\n`);
          await rd.chunks(size, async () => undefined);
          await rd.byte();
          continue;
        }
        await write('\0');
        let ok = false;
        try {
          let pos = 0;
          await rd.chunks(size, async (b) => {
            await fh!.write(b, 0, b.length, pos);
            pos += b.length;
          });
          const status = await rd.byte();
          // Algunos clientes (libssh reciente) cierran el canal justo tras los datos sin mandar el
          // byte de estado final: si llegaron todos los bytes, el archivo está completo.
          ok = status === 0 || status === null;
        } finally {
          await fh.close();
          if (ok) {
            await fs.rename(tmp, dest);
            if (times && cmd.preserve) await fs.utimes(dest, times.atime, times.mtime).catch(() => undefined);
          } else await fs.rm(tmp, { force: true });
        }
        times = null;
        if (!ok) return 1;
        const secs = Math.max((Date.now() - started) / 1000, 0.001);
        this.log('transfer', `${ip} subió ${vdest} por SCP (${size} bytes, ${secs.toFixed(1)} s)`);
        await write('\0');
      } else if (type === 'E') {
        stack.pop();
        await write('\0');
      } else if (line.charCodeAt(0) === 1 || line.charCodeAt(0) === 2) {
        this.log('warn', `${ip}: el cliente SCP avisó: ${rest}`);
        if (line.charCodeAt(0) === 2) return 1;
      } else {
        await write('\x02scp: protocolo no válido\n');
        return 1;
      }
    }
    return errors ? 1 : 0;
  }

  private async scpSource(rd: ChannelReader, write: (b: Buffer | string) => Promise<void>, cmd: ScpCommand, ip: string): Promise<number> {
    const ack = async (): Promise<boolean> => {
      const b = await rd.byte();
      if (b === 0) return true;
      if (b === 1 || b === 2) await rd.line();
      return false;
    };
    let errors = 0;
    const warn = async (msg: string) => {
      errors++;
      this.log('warn', `${ip}: SCP: ${msg}`);
      await write(`\x01scp: ${msg}\n`);
    };
    const sendTimes = async (st: Stats): Promise<boolean> => {
      if (!cmd.preserve) return true;
      await write(`T${Math.floor(st.mtimeMs / 1000)} 0 ${Math.floor(st.atimeMs / 1000)} 0\n`);
      return ack();
    };
    const sendPath = async (real: string, vpath: string): Promise<boolean> => {
      const st = await fs.stat(real).catch(() => null);
      const name = basename(real);
      if (!st) {
        await warn(`${vpath}: no existe`);
        return true;
      }
      if (st.isDirectory()) {
        if (!cmd.recursive) {
          await warn(`${vpath}: es una carpeta (usa -r)`);
          return true;
        }
        if (!(await sendTimes(st))) return false;
        await write(`D${(st.mode & 0o7777).toString(8).padStart(4, '0')} 0 ${name}\n`);
        if (!(await ack())) return false;
        for (const child of (await fs.readdir(real)).sort()) {
          if (!(await sendPath(join(real, child), posix.join(vpath, child)))) return false;
        }
        await write('E\n');
        return ack();
      }
      if (!st.isFile()) {
        await warn(`${vpath}: no es un archivo normal`);
        return true;
      }
      if (!(await sendTimes(st))) return false;
      await write(`C${(st.mode & 0o777).toString(8).padStart(4, '0')} ${st.size} ${name}\n`);
      if (!(await ack())) return false;
      const started = Date.now();
      for await (const chunk of createReadStream(real)) await write(chunk as Buffer);
      await write('\0');
      const ok = await ack();
      if (ok) this.log('transfer', `${ip} descargó ${vpath} por SCP (${st.size} bytes, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
      return ok;
    };
    if (!(await ack())) return 1;
    for (const p of cmd.paths) {
      const vpath = virtualPath(p);
      const real = this.real(vpath);
      if (!real) {
        await warn(`${p}: acceso denegado`);
        continue;
      }
      if (!(await sendPath(real, vpath))) return 1;
    }
    return errors ? 1 : 0;
  }
}
