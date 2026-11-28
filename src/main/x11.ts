// Reenvío X11: localiza el servidor X local, obtiene su cookie y hace de proxy de las conexiones
// X que llegan del servidor SSH, sustituyendo la cookie falsa que se envía al remoto por la real
// (igual que hace OpenSSH). Así la cookie real nunca sale de este equipo y funciona aunque no
// esté instalado el programa `xauth`.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect as netConnect, Socket } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

export interface DisplayTarget {
  /** Socket Unix (Linux/macOS). */
  path?: string;
  host?: string;
  port?: number;
  /** Número de pantalla (el N de `:N`). */
  number: number;
  screen: number;
}

/** Interpreta un valor de DISPLAY («:0», «localhost:10.0», «/ruta/socket:0»…). */
export function parseDisplay(display: string | undefined, platform: NodeJS.Platform = process.platform): DisplayTarget {
  const d = (display || '').trim() || (platform === 'win32' ? 'localhost:0.0' : ':0');
  const m = /^(.*):(\d+)(?:\.(\d+))?$/.exec(d);
  if (!m) return platform === 'win32' ? { host: '127.0.0.1', port: 6000, number: 0, screen: 0 } : { path: '/tmp/.X11-unix/X0', number: 0, screen: 0 };
  const [, host, num, screen] = m;
  const n = Number(num);
  const sc = Number(screen || 0);
  if (host.startsWith('/')) return { path: `${host}:${n}`, number: n, screen: sc }; // XQuartz y similares
  if (!host || host === 'unix') {
    if (platform === 'win32') return { host: '127.0.0.1', port: 6000 + n, number: n, screen: sc };
    return { path: `/tmp/.X11-unix/X${n}`, number: n, screen: sc };
  }
  return { host, port: 6000 + n, number: n, screen: sc };
}

/**
 * Decide qué DISPLAY local usar: el configurado en la sesión, el del entorno o, en Linux, el
 * primer socket de /tmp/.X11-unix (p. ej. XWayland cuando la aplicación se lanzó sin DISPLAY).
 */
export function resolveLocalDisplay(
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  socketDir = '/tmp/.X11-unix',
): { display: string; source: 'sesion' | 'entorno' | 'detectado' | 'predeterminado' } {
  if (override && override.trim()) return { display: override.trim(), source: 'sesion' };
  if (env.DISPLAY && env.DISPLAY.trim()) return { display: env.DISPLAY.trim(), source: 'entorno' };
  if (platform !== 'win32') {
    try {
      const nums = readdirSync(socketDir)
        .map((f) => /^X(\d+)$/.exec(f))
        .filter((x): x is RegExpExecArray => !!x)
        .map((x) => Number(x[1]))
        .sort((a, b) => a - b);
      if (nums.length) return { display: `:${nums[0]}`, source: 'detectado' };
    } catch {
      /* sin directorio de sockets */
    }
  }
  return { display: platform === 'win32' ? 'localhost:0.0' : ':0', source: 'predeterminado' };
}

export interface XauthEntry {
  family: number;
  address: Buffer;
  number: string;
  name: string;
  data: Buffer;
}

/** Lee un archivo Xauthority (formato binario de libXau). */
export function parseXauthority(buf: Buffer): XauthEntry[] {
  const out: XauthEntry[] = [];
  let p = 0;
  const field = (): Buffer | null => {
    if (p + 2 > buf.length) return null;
    const len = buf.readUInt16BE(p);
    p += 2;
    if (p + len > buf.length) return null;
    const b = buf.subarray(p, p + len);
    p += len;
    return b;
  };
  while (p + 2 <= buf.length) {
    const family = buf.readUInt16BE(p);
    p += 2;
    const address = field();
    const number = field();
    const name = field();
    const data = field();
    if (!address || !number || !name || !data) break;
    out.push({ family, address: Buffer.from(address), number: number.toString('latin1'), name: name.toString('latin1'), data: Buffer.from(data) });
  }
  return out;
}

const FAMILY_INTERNET = 0;
const FAMILY_INTERNET6 = 6;
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;

/** Elige la cookie MIT-MAGIC-COOKIE-1 adecuada para la pantalla indicada. */
export function pickCookie(entries: XauthEntry[], target: DisplayTarget, host = hostname()): { protocol: string; cookie: Buffer } | null {
  const usable = entries.filter((e) => e.name === 'MIT-MAGIC-COOKIE-1' && e.data.length > 0);
  const local = !target.host || ['localhost', '127.0.0.1', '::1'].includes(target.host);
  const score = (e: XauthEntry): number => {
    const numOk = e.number === String(target.number) || e.number === '';
    if (!numOk) return 0;
    if (e.family === FAMILY_WILD) return 3;
    if (local && e.family === FAMILY_LOCAL && e.address.toString('latin1') === host) return 4;
    if (local && e.family === FAMILY_INTERNET && e.address.equals(Buffer.from([127, 0, 0, 1]))) return 3;
    if (local && e.family === FAMILY_INTERNET6 && e.address.length === 16 && e.address.readUInt8(15) === 1) return 2;
    if (!local && e.family === FAMILY_LOCAL && e.address.toString('latin1') === target.host) return 4;
    if (local && e.family === FAMILY_LOCAL) return 1; // el nombre de equipo cambió (p. ej. contenedores)
    return 0;
  };
  let best: XauthEntry | null = null;
  let bestScore = 0;
  for (const e of usable) {
    const s = score(e);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best ? { protocol: best.name, cookie: best.data } : null;
}

/** Busca la cookie del servidor X local en $XAUTHORITY o ~/.Xauthority. */
export function localXCookie(target: DisplayTarget, env: NodeJS.ProcessEnv = process.env): { protocol: string; cookie: Buffer } | null {
  const candidates = [env.XAUTHORITY, join(env.HOME || env.USERPROFILE || homedir(), '.Xauthority')].filter((x): x is string => !!x);
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const c = pickCookie(parseXauthority(readFileSync(file)), target);
      if (c) return c;
    } catch {
      /* archivo ilegible */
    }
  }
  return null;
}

/** Abre una conexión con el servidor X local (con alternativa al socket abstracto de Linux). */
export function connectLocalX(target: DisplayTarget, platform: NodeJS.Platform = process.platform): Promise<Socket> {
  const attempt = (open: () => Socket) =>
    new Promise<Socket>((resolve, reject) => {
      const s = open();
      s.once('connect', () => {
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', reject);
    });
  if (target.path) {
    const path = target.path;
    return attempt(() => netConnect(path)).catch((e) => {
      // Xorg/XWayland también escuchan en el socket abstracto «@/tmp/.X11-unix/XN»; sirve
      // cuando /tmp no es el del sistema (Flatpak, Snap, AppImage en sandbox…).
      if (platform === 'linux') return attempt(() => netConnect('\0' + path));
      throw e;
    });
  }
  return attempt(() => netConnect(target.port!, target.host!));
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/**
 * Reescribe el mensaje inicial de una conexión X11 que llega del servidor remoto: comprueba que
 * trae la cookie falsa y la sustituye por la real (o la elimina si no hay cookie local, para que
 * decida el control de acceso del servidor X, p. ej. «xhost +si:localuser»).
 * Devuelve null mientras falten bytes; lanza si la autenticación no coincide.
 */
export function rewriteSetup(
  buf: Buffer,
  fake: { protocol: string; cookie: Buffer },
  real: { protocol: string; cookie: Buffer } | null,
): Buffer | null {
  if (buf.length < 12) return null;
  const order = buf[0];
  if (order !== 0x42 && order !== 0x6c) throw new Error('Mensaje X11 no válido');
  const be = order === 0x42;
  const r16 = (o: number) => (be ? buf.readUInt16BE(o) : buf.readUInt16LE(o));
  const nameLen = r16(6);
  const dataLen = r16(8);
  const total = 12 + nameLen + pad4(nameLen) + dataLen + pad4(dataLen);
  if (buf.length < total) return null;
  const name = buf.subarray(12, 12 + nameLen).toString('latin1');
  const dStart = 12 + nameLen + pad4(nameLen);
  const data = buf.subarray(dStart, dStart + dataLen);
  if (name !== fake.protocol || !data.equals(fake.cookie)) throw new Error('La conexión X11 usa una autenticación distinta');
  const rName = Buffer.from(real ? real.protocol : '', 'latin1');
  const rData = real ? real.cookie : Buffer.alloc(0);
  const head = Buffer.from(buf.subarray(0, 12));
  const w16 = (o: number, v: number) => (be ? head.writeUInt16BE(v, o) : head.writeUInt16LE(v, o));
  w16(6, rName.length);
  w16(8, rData.length);
  return Buffer.concat([
    head,
    rName,
    Buffer.alloc(pad4(rName.length)),
    rData,
    Buffer.alloc(pad4(rData.length)),
    buf.subarray(total),
  ]);
}

export function fakeCookie(): { protocol: string; cookie: Buffer } {
  return { protocol: 'MIT-MAGIC-COOKIE-1', cookie: randomBytes(16) };
}

/** Une un canal X11 remoto con el servidor X local, sustituyendo la cookie. */
export function proxyX11Channel(
  remote: Duplex,
  target: DisplayTarget,
  fake: { protocol: string; cookie: Buffer },
  real: { protocol: string; cookie: Buffer } | null,
  onError: (msg: string, kind: 'auth' | 'connect') => void,
): void {
  let buf = Buffer.alloc(0);
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    let out: Buffer | null;
    try {
      out = rewriteSetup(buf, fake, real);
    } catch (e) {
      remote.removeListener('data', onData);
      remote.destroy();
      onError((e as Error).message, 'auth');
      return;
    }
    if (!out) {
      if (buf.length > 65536) remote.destroy();
      return;
    }
    remote.removeListener('data', onData);
    remote.pause();
    const first = out;
    connectLocalX(target).then(
      (local) => {
        local.write(first);
        remote.pipe(local).pipe(remote);
        remote.resume();
        remote.on('close', () => local.destroy());
        local.on('close', () => remote.destroy());
        local.on('error', () => remote.destroy());
        remote.on('error', () => local.destroy());
      },
      (e: Error) => {
        remote.destroy();
        onError(e.message, 'connect');
      },
    );
  };
  remote.on('data', onData);
}
