import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, AddressInfo, Socket } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, Connection } from 'ssh2';
import { generateKeyPairChecked } from '../src/main/keys';
import { parseDisplay, parseXauthority, pickCookie, resolveLocalDisplay, rewriteSetup } from '../src/main/x11';
import { SshConnection, SshDeps } from '../src/main/protocols/ssh';
import type { SessionConfig } from '../src/shared/types';

function xauthEntry(family: number, address: Buffer, number: string, name: string, data: Buffer): Buffer {
  const f = (b: Buffer) => {
    const l = Buffer.alloc(2);
    l.writeUInt16BE(b.length);
    return Buffer.concat([l, b]);
  };
  const fam = Buffer.alloc(2);
  fam.writeUInt16BE(family);
  return Buffer.concat([fam, f(address), f(Buffer.from(number)), f(Buffer.from(name)), f(data)]);
}

/** Mensaje inicial de un cliente X (orden de bytes «l», little endian). */
function setupMsg(proto: string, cookie: Buffer, extra = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(12);
  head[0] = 0x6c;
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(proto.length, 6);
  head.writeUInt16LE(cookie.length, 8);
  const pad = (n: number) => Buffer.alloc((4 - (n % 4)) % 4);
  return Buffer.concat([head, Buffer.from(proto), pad(proto.length), cookie, pad(cookie.length), extra]);
}

test('X11: interpreta DISPLAY en Linux y Windows', () => {
  assert.deepEqual(parseDisplay('localhost:10.0', 'linux'), { host: 'localhost', port: 6010, number: 10, screen: 0 });
  assert.deepEqual(parseDisplay(':1', 'linux'), { path: '/tmp/.X11-unix/X1', number: 1, screen: 0 });
  assert.deepEqual(parseDisplay(':0.1', 'win32'), { host: '127.0.0.1', port: 6000, number: 0, screen: 1 });
  assert.deepEqual(parseDisplay(undefined, 'win32'), { host: 'localhost', port: 6000, number: 0, screen: 0 });
  assert.deepEqual(parseDisplay('/private/tmp/xquartz:0', 'darwin'), { path: '/private/tmp/xquartz:0', number: 0, screen: 0 });
});

test('X11: elige el DISPLAY local (sesión, entorno o socket detectado)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-x11-'));
  writeFileSync(join(dir, 'X1'), '');
  writeFileSync(join(dir, 'X0-lock'), '');
  assert.deepEqual(resolveLocalDisplay(':5', { DISPLAY: ':0' }, 'linux', dir), { display: ':5', source: 'sesion' });
  assert.deepEqual(resolveLocalDisplay(undefined, { DISPLAY: ':0' }, 'linux', dir), { display: ':0', source: 'entorno' });
  assert.deepEqual(resolveLocalDisplay('', {}, 'linux', dir), { display: ':1', source: 'detectado' });
  assert.deepEqual(resolveLocalDisplay('', {}, 'linux', join(dir, 'no')), { display: ':0', source: 'predeterminado' });
  assert.deepEqual(resolveLocalDisplay('', {}, 'win32', dir), { display: 'localhost:0.0', source: 'predeterminado' });
});

test('X11: lee Xauthority y elige la cookie de la pantalla', () => {
  const c0 = Buffer.alloc(16, 0xaa);
  const c1 = Buffer.alloc(16, 0xbb);
  const wild = Buffer.alloc(16, 0xcc);
  const file = Buffer.concat([
    xauthEntry(256, Buffer.from('equipo'), '0', 'MIT-MAGIC-COOKIE-1', c0),
    xauthEntry(256, Buffer.from('equipo'), '1', 'MIT-MAGIC-COOKIE-1', c1),
    xauthEntry(65535, Buffer.alloc(0), '2', 'MIT-MAGIC-COOKIE-1', wild),
  ]);
  const entries = parseXauthority(file);
  assert.equal(entries.length, 3);
  assert.deepEqual(pickCookie(entries, parseDisplay(':1', 'linux'), 'equipo')?.cookie, c1);
  assert.deepEqual(pickCookie(entries, parseDisplay('localhost:0', 'linux'), 'equipo')?.cookie, c0);
  assert.deepEqual(pickCookie(entries, parseDisplay(':2', 'linux'), 'equipo')?.cookie, wild);
  // Con otro nombre de equipo se acepta la entrada local de la misma pantalla.
  assert.deepEqual(pickCookie(entries, parseDisplay(':0', 'linux'), 'otro')?.cookie, c0);
  assert.equal(pickCookie(entries, parseDisplay(':7', 'linux'), 'equipo'), null);
});

test('X11: sustituye la cookie falsa por la real', () => {
  const fake = { protocol: 'MIT-MAGIC-COOKIE-1', cookie: Buffer.alloc(16, 1) };
  const real = { protocol: 'MIT-MAGIC-COOKIE-1', cookie: Buffer.alloc(16, 2) };
  const msg = setupMsg(fake.protocol, fake.cookie, Buffer.from('resto'));
  assert.equal(rewriteSetup(msg.subarray(0, 20), fake, real), null);
  assert.deepEqual(rewriteSetup(msg, fake, real), setupMsg(real.protocol, real.cookie, Buffer.from('resto')));
  assert.deepEqual(rewriteSetup(msg, fake, null), setupMsg('', Buffer.alloc(0), Buffer.from('resto')));
  assert.throws(() => rewriteSetup(setupMsg(fake.protocol, Buffer.alloc(16, 9)), fake, real), /autenticación distinta/);
});

/** Servidor SSH mínimo que acepta (o no) x11-req y, al escribir «xapp», abre un canal X11. */
async function x11Server(acceptX11: boolean) {
  const hostKey = generateKeyPairChecked('ed25519');
  let req: { protocol: string; cookie: string; screen: number } | null = null;
  const server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'x' ? ctx.accept() : ctx.reject(['password'])));
    client.on('error', () => undefined);
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('pty', (accept) => accept?.());
      session.on('x11', (accept, reject, info) => {
        if (!acceptX11) return reject?.();
        // ssh2 entrega la cookie como texto hexadecimal (en un Buffer).
        req = { protocol: String(info.protocol), cookie: String(info.cookie), screen: info.screen };
        accept?.();
      });
      session.on('shell', (accept) => {
        const ch = accept();
        ch.write(`listo display=${req ? 'localhost:10.' + req.screen : '(vacío)'}\r\n`);
        ch.on('data', (d: Buffer) => {
          if (!d.toString().includes('xapp') || !req) return;
          client.x11('127.0.0.1', 50000, (err, xch) => {
            if (err) return ch.write('x11:error\r\n');
            xch.write(setupMsg(req!.protocol, Buffer.from(req!.cookie, 'hex')));
            xch.once('data', (r: Buffer) => ch.write(`x11:${r.toString()}\r\n`));
          });
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as AddressInfo).port, server, req: () => req };
}

/** Servidor X falso: responde «ok» si la cookie recibida es la esperada. */
async function fakeXServer(expected: Buffer | null) {
  const got: Buffer[] = [];
  const srv = createServer((s: Socket) => {
    s.once('data', (d: Buffer) => {
      got.push(d);
      const dataLen = d.readUInt16LE(8);
      const nameLen = d.readUInt16LE(6);
      const start = 12 + nameLen + ((4 - (nameLen % 4)) % 4);
      const cookie = d.subarray(start, start + dataLen);
      s.write(expected ? (cookie.equals(expected) ? 'ok' : 'mal') : dataLen === 0 ? 'ok' : 'mal');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, display: `127.0.0.1:${(srv.address() as AddressInfo).port - 6000}`, got };
}

function deps(): SshDeps {
  return {
    prompter: { hostKey: async () => true, auth: async () => ['x'] },
    knownHosts: { get: () => undefined, set: async () => undefined },
    secretFor: () => ({ password: 'x' }),
    sessionById: () => undefined,
    onTunnelsChanged: () => undefined,
  };
}

function waitFor(conn: SshConnection, text: string, ms = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout esperando "${text}": ${JSON.stringify(buf)}`)), ms);
    const on = (d: string) => {
      buf += d;
      if (buf.includes(text)) {
        clearTimeout(t);
        conn.off('data', on);
        resolve(buf);
      }
    };
    conn.on('data', on);
  });
}

test('X11: reenvío activado por defecto, con cookie falsa hacia el servidor y la real en local', async () => {
  const real = Buffer.alloc(16, 0x5a);
  const x = await fakeXServer(real);
  const home = mkdtempSync(join(tmpdir(), 'nexus-xauth-'));
  mkdirSync(home, { recursive: true });
  const num = String((x.srv.address() as AddressInfo).port - 6000);
  writeFileSync(join(home, 'xauth'), xauthEntry(0, Buffer.from([127, 0, 0, 1]), num, 'MIT-MAGIC-COOKIE-1', real));
  const prev = process.env.XAUTHORITY;
  process.env.XAUTHORITY = join(home, 'xauth');
  const s = await x11Server(true);
  const cfg: SessionConfig = { id: 'x', name: 'x', folder: '', kind: 'ssh', host: '127.0.0.1', port: s.port, username: 'u', auth: 'password', x11Display: x.display };
  const c = new SshConnection(cfg, deps(), 'cx');
  try {
    const ready = waitFor(c, 'listo display=localhost:10.0');
    await c.open(80, 24);
    await ready;
    assert.ok(s.req(), 'el cliente pidió x11-req');
    assert.notEqual(s.req()!.cookie, real.toString('hex'), 'la cookie real no sale del equipo');
    const ok = waitFor(c, 'x11:ok');
    c.write('xapp\r');
    await ok;
  } finally {
    c.close();
    s.server.close();
    x.srv.close();
    if (prev === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = prev;
  }
});

test('X11: sin cookie local se envía la conexión sin autenticación', async () => {
  const x = await fakeXServer(null);
  const prev = process.env.XAUTHORITY;
  process.env.XAUTHORITY = join(tmpdir(), 'nexus-no-existe-xauth');
  const prevHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'nexus-home-'));
  const s = await x11Server(true);
  const c = new SshConnection({ id: 'x', name: 'x', folder: '', kind: 'ssh', host: '127.0.0.1', port: s.port, username: 'u', auth: 'password', x11Display: x.display }, deps(), 'cy');
  try {
    const ready = waitFor(c, 'listo');
    await c.open(80, 24);
    await ready;
    const ok = waitFor(c, 'x11:ok');
    c.write('xapp\r');
    await ok;
  } finally {
    c.close();
    s.server.close();
    x.srv.close();
    if (prev === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = prev;
    process.env.HOME = prevHome;
  }
});

test('X11: si el servidor rechaza el reenvío, el shell se abre igualmente con un aviso', async () => {
  const s = await x11Server(false);
  const c = new SshConnection({ id: 'x', name: 'x', folder: '', kind: 'ssh', host: '127.0.0.1', port: s.port, username: 'u', auth: 'password' }, deps(), 'cz');
  try {
    const out = waitFor(c, 'listo display=(vacío)');
    await c.open(80, 24);
    assert.match(await out, /X11Forwarding yes/);
  } finally {
    c.close();
    s.server.close();
  }
});

test('X11: avisa en el terminal si no hay servidor X local', async () => {
  const s = await x11Server(true);
  const free = createServer();
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()));
  const port = (free.address() as AddressInfo).port;
  await new Promise<void>((r) => free.close(() => r()));
  const c = new SshConnection({ id: 'x', name: 'x', folder: '', kind: 'ssh', host: '127.0.0.1', port: s.port, username: 'u', auth: 'password', x11Display: `127.0.0.1:${port - 6000}` }, deps(), 'cw');
  try {
    const ready = waitFor(c, 'listo');
    await c.open(80, 24);
    await ready;
    const warn = waitFor(c, 'No se pudo conectar con el servidor X local');
    c.write('xapp\r');
    await warn;
  } finally {
    c.close();
    s.server.close();
  }
});
