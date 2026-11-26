import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, AddressInfo, Server } from 'node:net';
import { startTestServer, TestServer } from './helpers/ssh-server';
import { SshConnection, SshDeps, fingerprintOf, parseDisplay } from '../src/main/protocols/ssh';
import { TelnetConnection } from '../src/main/protocols/telnet';
import * as sftpOps from '../src/main/sftp-ops';
import type { SessionConfig, SecretEntry } from '../src/shared/types';

let srv: TestServer;
let root: string;
let echo: Server;
let echoPort: number;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'nexus-sftp-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'leeme.txt'), 'hola mundo');
  srv = await startTestServer(root);
  echo = createServer((s) => s.on('data', (d) => s.write(`ECO ${d}`)));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoPort = (echo.address() as AddressInfo).port;
});

after(async () => {
  await srv.close();
  echo.close();
});

function deps(over: Partial<SshDeps> = {}, sessions: SessionConfig[] = [], secrets: Record<string, SecretEntry> = {}) {
  const known = new Map<string, string>();
  const asked: string[] = [];
  const d: SshDeps = {
    prompter: {
      hostKey: async (p) => {
        asked.push(p.fingerprint);
        return true;
      },
      auth: async () => ['secreto'],
    },
    knownHosts: { get: (id) => known.get(id), set: async (id, fp) => void known.set(id, fp) },
    secretFor: (id) => secrets[id],
    sessionById: (id) => sessions.find((s) => s.id === id),
    onTunnelsChanged: () => undefined,
    ...over,
  };
  return { d, known, asked };
}

const cfg = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  id: 's1', name: 'test', folder: '', kind: 'ssh', host: '127.0.0.1', port: srv.port, username: 'nexus', auth: 'password', ...over,
});

function waitFor(conn: SshConnection | TelnetConnection, text: string, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout esperando "${text}". Recibido: ${JSON.stringify(buf)}`)), ms);
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

test('SSH: verifica la huella (TOFU), autentica con la bóveda y abre shell', async () => {
  const { d, known, asked } = deps({}, [], { s1: { password: 'secreto' } });
  const c = new SshConnection(cfg(), d, 'c1');
  const welcome = waitFor(c, 'Bienvenido');
  await c.open(80, 24);
  await welcome;
  assert.equal(asked.length, 1);
  assert.equal(asked[0], fingerprintOf(srv.hostKeyFingerprintSource));
  assert.equal(known.get(`[127.0.0.1]:${srv.port}`), asked[0]);
  const got = waitFor(c, 'eco:ls');
  c.write('ls');
  await got;
  c.resize(120, 40);
  c.close();

  // Segunda conexión: la huella ya es conocida y no se pregunta.
  const c2 = new SshConnection(cfg(), d, 'c2');
  await c2.open(80, 24);
  assert.equal(asked.length, 1);
  c2.close();
});

test('SSH: detecta cambio de clave de host y aborta si el usuario no acepta', async () => {
  const known = new Map([[`[127.0.0.1]:${srv.port}`, 'SHA256:otra']]);
  let previous: string | undefined;
  const { d } = deps({
    knownHosts: { get: (id) => known.get(id), set: async () => undefined },
    prompter: { hostKey: async (p) => ((previous = p.previous), false), auth: async () => ['secreto'] },
  });
  await assert.rejects(new SshConnection(cfg(), d, 'c3').open(80, 24));
  assert.equal(previous, 'SHA256:otra');
});

test('SSH: pide la contraseña si no está guardada y falla con credenciales malas', async () => {
  let prompts = 0;
  const { d } = deps({ prompter: { hostKey: async () => true, auth: async () => (prompts++, ['secreto']) } });
  const c = new SshConnection(cfg(), d, 'c4');
  await c.open(80, 24);
  assert.ok(prompts >= 1);
  c.close();

  const bad = deps({ prompter: { hostKey: async () => true, auth: async () => ['mala'] } });
  await assert.rejects(new SshConnection(cfg(), bad.d, 'c5').open(80, 24), /authentication/i);
});

test('SFTP: listar, subir, descargar, editar, renombrar y borrar', async () => {
  const { d } = deps({}, [], { s1: { password: 'secreto' } });
  const c = new SshConnection(cfg(), d, 'c6');
  await c.open(80, 24);
  const s = await c.sftp();
  assert.equal(await sftpOps.realpath(s, '.'), '/');
  const list = await sftpOps.list(s, '/');
  assert.deepEqual(list.map((e) => [e.name, e.isDir]), [['docs', true]]);
  assert.equal(await sftpOps.readText(s, '/docs/leeme.txt'), 'hola mundo');

  await sftpOps.writeText(s, '/docs/nuevo.txt', 'contenido ñ');
  assert.equal(readFileSync(join(root, 'docs', 'nuevo.txt'), 'utf8'), 'contenido ñ');

  const local = mkdtempSync(join(tmpdir(), 'nexus-local-'));
  writeFileSync(join(local, 'subida.bin'), Buffer.alloc(300_000, 7));
  const progress: number[] = [];
  await sftpOps.upload(s, join(local, 'subida.bin'), '/docs', (_f, t) => progress.push(t));
  assert.equal(readFileSync(join(root, 'docs', 'subida.bin')).length, 300_000);
  assert.equal(progress.at(-1), 300_000);

  const dl = mkdtempSync(join(tmpdir(), 'nexus-dl-'));
  await sftpOps.download(s, '/docs', dl, () => undefined);
  assert.equal(readFileSync(join(dl, 'docs', 'leeme.txt'), 'utf8'), 'hola mundo');
  assert.equal(readFileSync(join(dl, 'docs', 'subida.bin')).length, 300_000);

  await sftpOps.mkdir(s, '/tmpdir');
  await sftpOps.rename(s, '/docs/nuevo.txt', '/tmpdir/movido.txt');
  assert.ok(existsSync(join(root, 'tmpdir', 'movido.txt')));
  await sftpOps.remove(s, '/tmpdir', true);
  assert.ok(!existsSync(join(root, 'tmpdir')));
  c.close();
});

test('Túneles: local (-L), dinámico SOCKS5 (-D) y remoto (-R)', async () => {
  const { d } = deps({}, [], { s1: { password: 'secreto' } });
  const c = new SshConnection(cfg({
    tunnels: [
      { id: 'L', name: '', type: 'local', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echoPort, autoStart: false },
    ],
  }), d, 'c7');
  await c.open(80, 24);
  const tm = c.tunnels!;

  // -L: puerto libre elegido dinámicamente.
  const lPort = await freePort();
  tm.add({ id: 'L2', name: '', type: 'local', bindHost: '127.0.0.1', bindPort: lPort, destHost: '127.0.0.1', destPort: echoPort, autoStart: false });
  await tm.start('L2');
  assert.equal(await roundtrip(lPort, 'hola'), 'ECO hola');

  // -D: SOCKS5 con CONNECT a dominio.
  const dPort = await freePort();
  tm.add({ id: 'D', name: '', type: 'dynamic', bindHost: '127.0.0.1', bindPort: dPort, destHost: '', destPort: 0, autoStart: false });
  await tm.start('D');
  assert.equal(await socksRoundtrip(dPort, 'localhost', echoPort, 'socks'), 'ECO socks');

  // -R: el servidor escucha y reenvía al eco local.
  const rPort = await freePort();
  tm.add({ id: 'R', name: '', type: 'remote', bindHost: '127.0.0.1', bindPort: rPort, destHost: '127.0.0.1', destPort: echoPort, autoStart: false });
  await tm.start('R');
  assert.equal(await roundtrip(rPort, 'remoto'), 'ECO remoto');

  const st = tm.status();
  assert.deepEqual(st.filter((x) => x.state === 'listening').map((x) => x.tunnelId).sort(), ['D', 'L2', 'R']);
  await tm.stop('L2');
  assert.equal(tm.status().find((x) => x.tunnelId === 'L2')!.state, 'stopped');
  c.close();
});

test('ProxyJump: conecta a través de un bastión', async () => {
  const bastion = cfg({ id: 'b', name: 'bastion' });
  const target = cfg({ id: 't', name: 'destino', jumpSessionId: 'b' });
  const { d, asked } = deps({}, [bastion, target], { b: { password: 'secreto' }, t: { password: 'secreto' } });
  const c = new SshConnection(target, d, 'c8');
  const w = waitFor(c, 'Bienvenido');
  await c.open(80, 24);
  await w;
  assert.ok(asked.length >= 1);
  c.close();
});

test('Monitor remoto mediante exec', async () => {
  const { d } = deps({}, [], { s1: { password: 'secreto' } });
  const c = new SshConnection(cfg(), d, 'c9');
  await c.open(80, 24);
  const out = await c.exec('cat /proc/loadavg');
  assert.ok(out.includes('0.42'));
  c.close();
});

test('Telnet: negocia y muestra datos', async () => {
  const tsrv = createServer((s) => {
    s.write(Buffer.from([255, 253, 31])); // IAC DO NAWS
    s.write('login: ');
    s.on('data', (d) => {
      if (d.includes('admin')) s.write('\r\nhola admin\r\n');
    });
  });
  await new Promise<void>((r) => tsrv.listen(0, '127.0.0.1', () => r()));
  const port = (tsrv.address() as AddressInfo).port;
  const c = new TelnetConnection({ id: 'tn', name: 't', folder: '', kind: 'telnet', host: '127.0.0.1', port });
  const w = waitFor(c, 'login:');
  await c.open(100, 30);
  await w;
  const w2 = waitFor(c, 'hola admin');
  c.write('admin\r');
  await w2;
  c.close();
  tsrv.close();
});

test('X11: interpreta DISPLAY', () => {
  assert.deepEqual(parseDisplay('localhost:10.0'), { host: 'localhost', port: 6010, screen: 0 });
  if (process.platform !== 'win32') assert.deepEqual(parseDisplay(':1'), { path: '/tmp/.X11-unix/X1', screen: 0 });
});

// ---------------------------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

function roundtrip(port: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(msg));
    s.once('data', (d) => {
      resolve(d.toString());
      s.destroy();
    });
    s.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
}

function socksRoundtrip(port: number, host: string, destPort: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    let stage = 0;
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      if (stage === 0) {
        assert.deepEqual([...d], [5, 0]);
        stage = 1;
        const h = Buffer.from(host);
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([destPort >> 8, destPort & 0xff])]);
        s.write(req);
      } else if (stage === 1) {
        assert.equal(d[1], 0, 'SOCKS debe responder éxito');
        stage = 2;
        s.write(msg);
      } else {
        resolve(d.toString());
        s.destroy();
      }
    });
    s.once('error', reject);
    setTimeout(() => reject(new Error('timeout socks')), 3000);
  });
}
