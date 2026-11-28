// Pruebas de los servidores SFTP/SCP, HTTPS y DHCP.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomBytes, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { Client, SFTPWrapper } from 'ssh2';
import { SftpServer, parseScpCommand, shellSplit, virtualPath } from '../src/main/servers/sftp';
import { HttpFileServer } from '../src/main/servers/http';
import { selfSignedCert, loadOrCreateSelfSigned } from '../src/main/servers/cert';
import { DhcpEngine, DhcpServer, dhcpSettings, buildPacket, parsePacket, MSG, ipToInt, intToIp } from '../src/main/servers/dhcp';
import { addMissingKinds, defaultServers } from '../src/main/servers/manager';
import { generateKeyPairChecked } from '../src/main/keys';
import type { ServerConfig, ServerLogEntry } from '../src/shared/types';

let root: string;
let state: string;
const firmware = randomBytes(700_000);

let curlInfo = '';
try {
  curlInfo = execFileSync('curl', ['-V'], { encoding: 'utf8' });
} catch {
  /* sin curl */
}
const curlHas = (p: string) => new RegExp(`Protocols:.*\\b${p}\\b`).test(curlInfo);

function curl(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '20', ...args], { encoding: 'latin1', maxBuffer: 10 * 1024 * 1024 }, (e, out, err) =>
      resolve({ code: e ? ((e as any).code ?? 1) : 0, out, err }));
  });
}

const cfg = (kind: ServerConfig['kind'], extra: Partial<ServerConfig> = {}): ServerConfig => ({
  id: kind, kind, name: kind, rootDir: root, port: 0, bindHost: '127.0.0.1', allowWrite: true, ...extra,
});

before(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-srv2-'));
  state = mkdtempSync(join(tmpdir(), 'nexus-state-'));
  writeFileSync(join(root, 'firmware.bin'), firmware);
  mkdirSync(join(root, 'configs'));
  writeFileSync(join(root, 'configs', 'switch1.cfg'), 'hostname sw1\n');
});

test('manager: añade los tipos nuevos a una configuración antigua', () => {
  const old = defaultServers('/x').filter((c) => ['tftp', 'ftp', 'http', 'syslog'].includes(c.kind));
  const merged = addMissingKinds(old, '/x')!;
  assert.deepEqual(merged.map((c) => c.kind), ['tftp', 'ftp', 'sftp', 'http', 'https', 'syslog', 'dhcp']);
  assert.equal(merged[0].id, old[0].id, 'conserva los existentes');
  assert.equal(addMissingKinds(merged, '/x'), null);
});

// ------------------------------------------------------------------ HTTPS
test('certificado autofirmado: X.509 válido con nombres e IP', () => {
  const { cert, key } = selfSignedCert('equipo', ['localhost', '127.0.0.1', '::1', '10.1.2.3']);
  const x = new X509Certificate(cert);
  assert.ok(x.checkHost('localhost'));
  assert.ok(x.checkIP('127.0.0.1'));
  assert.ok(x.checkIP('10.1.2.3'));
  assert.ok(x.checkIP('::1'));
  assert.ok(x.verify(x.publicKey), 'firma correcta');
  assert.match(key, /BEGIN PRIVATE KEY/);
  assert.match(x.subject, /CN=equipo/);
  try {
    const txt = execFileSync('openssl', ['x509', '-noout', '-text'], { input: cert, encoding: 'utf8' });
    assert.match(txt, /Version: 3/);
    assert.match(txt, /TLS Web Server Authentication/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
});

test('certificado autofirmado: se reutiliza entre arranques', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cert-'));
  const a = await loadOrCreateSelfSigned(dir);
  const b = await loadOrCreateSelfSigned(dir);
  assert.ok(a.created);
  assert.ok(!b.created);
  assert.equal(a.fingerprint, b.fingerprint);
});

test('HTTPS: sirve archivos con el certificado autofirmado y acepta PUT', async () => {
  const srv = new HttpFileServer(cfg('https'), state);
  const logs: string[] = [];
  srv.on('log', (e: ServerLogEntry) => logs.push(e.message));
  await srv.start();
  const port = srv.boundPort()!;
  const ca = readFileSync(join(state, 'https-cert.pem'));
  const get = (path: string, method = 'GET', body?: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, ca }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const list = await get('/');
    assert.equal(list.status, 200);
    assert.match(list.body.toString(), /firmware\.bin/);
    assert.ok((await get('/firmware.bin')).body.equals(firmware));
    assert.equal((await get('/https/subido.txt', 'PUT', 'hola tls')).status, 201);
    assert.equal(readFileSync(join(root, 'https', 'subido.txt'), 'utf8'), 'hola tls');
    if (curlHas('https')) {
      const r = await curl(['--cacert', join(state, 'https-cert.pem'), `https://127.0.0.1:${port}/configs/switch1.cfg`]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'hostname sw1\n');
    }
    assert.ok(logs.some((l) => /HTTPS escuchando .*SHA-256/.test(l)));
  } finally {
    await srv.stop();
  }
});

test('HTTPS: usa el certificado del usuario y rechaza pares que no casan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mycert-'));
  const a = selfSignedCert('propio', ['127.0.0.1']);
  const b = selfSignedCert('otro', ['127.0.0.1']);
  writeFileSync(join(dir, 'a.crt'), a.cert);
  writeFileSync(join(dir, 'a.key'), a.key);
  writeFileSync(join(dir, 'b.key'), b.key);
  const bad = new HttpFileServer(cfg('https', { tlsCertPath: join(dir, 'a.crt'), tlsKeyPath: join(dir, 'b.key') }), state);
  await assert.rejects(bad.start(), /no corresponde/);
  const srv = new HttpFileServer(cfg('https', { tlsCertPath: join(dir, 'a.crt'), tlsKeyPath: join(dir, 'a.key') }), state);
  await srv.start();
  try {
    const subject = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: srv.boundPort(), path: '/', ca: a.cert }, (res) => {
        resolve((res.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN as string);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(subject, 'propio');
  } finally {
    await srv.stop();
  }
});

// ------------------------------------------------------------- SFTP / SCP
test('SFTP/SCP: análisis de órdenes y rutas', () => {
  assert.deepEqual(shellSplit(`scp -t -- 'mi carpeta/a b.bin'`), ['scp', '-t', '--', 'mi carpeta/a b.bin']);
  assert.deepEqual(shellSplit('scp -f "x\\"y" z\\ w'), ['scp', '-f', 'x"y', 'z w']);
  assert.deepEqual(parseScpCommand('scp -r -p -t /destino'), { mode: 'sink', recursive: true, preserve: true, targetIsDir: false, paths: ['/destino'] });
  assert.deepEqual(parseScpCommand('/usr/bin/scp -v -f a b'), { mode: 'source', recursive: false, preserve: false, targetIsDir: false, paths: ['a', 'b'] });
  assert.equal(parseScpCommand('rm -rf /'), null);
  assert.equal(parseScpCommand('scp -t'), null);
  assert.equal(virtualPath('../../etc'), '/etc');
  assert.equal(virtualPath('a/../b', '/x'), '/x/b');
  assert.equal(virtualPath(''), '/');
});

function sshConnect(port: number, auth: Record<string, unknown>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', reject).connect({ host: '127.0.0.1', port, username: 'nexus', readyTimeout: 10000, ...auth });
  });
}
const sftpOf = (c: Client) => new Promise<SFTPWrapper>((res, rej) => c.sftp((e, s) => (e ? rej(e) : res(s))));
const p = <T>(f: (cb: (e: Error | null | undefined, v?: T) => void) => void) => new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v as T))));

test('SFTP: contraseña, listado, descarga, subida, carpetas, renombrar y borrar', async () => {
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: 'clave' }), state);
  const logs: ServerLogEntry[] = [];
  srv.on('log', (e: ServerLogEntry) => logs.push(e));
  await srv.start();
  const port = srv.boundPort()!;
  try {
    await assert.rejects(sshConnect(port, { password: 'mala' }));
    const c = await sshConnect(port, { password: 'clave' });
    const sftp = await sftpOf(c);
    assert.equal(await p<string>((cb) => sftp.realpath('.', cb)), '/');
    const list = await p<{ filename: string; longname: string }[]>((cb) => sftp.readdir('/', cb));
    assert.ok(list.some((e) => e.filename === 'firmware.bin' && /^-rw/.test(e.longname)));
    assert.ok(list.some((e) => e.filename === 'configs' && /^d/.test(e.longname)));
    const dl = join(tmpdir(), `nexus-sftp-dl-${Date.now()}`);
    await p<void>((cb) => sftp.fastGet('/firmware.bin', dl, cb as never));
    assert.ok(readFileSync(dl).equals(firmware));
    await p<void>((cb) => sftp.mkdir('/nueva', cb as never));
    const up = join(tmpdir(), `nexus-sftp-up-${Date.now()}`);
    writeFileSync(up, firmware.subarray(0, 300_000));
    await p<void>((cb) => sftp.fastPut(up, '/nueva/imagen.bin', cb as never));
    assert.ok(readFileSync(join(root, 'nueva', 'imagen.bin')).equals(firmware.subarray(0, 300_000)));
    await p<void>((cb) => sftp.rename('/nueva/imagen.bin', '/nueva/img2.bin', cb as never));
    assert.ok(existsSync(join(root, 'nueva', 'img2.bin')));
    const st = await p<{ size: number }>((cb) => sftp.stat('/nueva/img2.bin', cb));
    assert.equal(st.size, 300_000);
    await p<void>((cb) => sftp.unlink('/nueva/img2.bin', cb as never));
    await p<void>((cb) => sftp.rmdir('/nueva', cb as never));
    assert.ok(!existsSync(join(root, 'nueva')));
    // Traversal: «..» se queda en la raíz virtual.
    const up2 = await p<{ filename: string }[]>((cb) => sftp.readdir('/../..', cb));
    assert.ok(up2.some((e) => e.filename === 'firmware.bin'));
    // Sin shell.
    const out = await new Promise<string>((resolve) => c.exec('cat /etc/passwd', (e, ch) => {
      let d = '';
      ch.resume();
      ch.stderr.on('data', (x: Buffer) => (d += x));
      ch.on('close', () => resolve(d));
    }));
    assert.match(out, /sólo admite SFTP y SCP/);
    c.end();
    assert.ok(logs.some((l) => l.level === 'transfer' && /subió \/nueva\/imagen\.bin por SFTP/.test(l.message)));
    assert.ok(logs.some((l) => l.level === 'warn' && /autenticación fallida/.test(l.message)));
  } finally {
    await srv.stop();
  }
});

test('SFTP: clave pública y modo sólo lectura', async () => {
  const pair = generateKeyPairChecked('ed25519');
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: '', authorizedKeys: `# equipo\n${pair.public}\n`, allowWrite: false }), state);
  await srv.start();
  try {
    const c = await sshConnect(srv.boundPort()!, { privateKey: pair.private });
    const sftp = await sftpOf(c);
    const data = await p<Buffer>((cb) => sftp.readFile('/configs/switch1.cfg', cb as never));
    assert.equal(data.toString(), 'hostname sw1\n');
    await assert.rejects(p<void>((cb) => sftp.writeFile('/prohibido.txt', 'x', cb as never)));
    assert.ok(!existsSync(join(root, 'prohibido.txt')));
    c.end();
    const other = generateKeyPairChecked('ed25519');
    await assert.rejects(sshConnect(srv.boundPort()!, { privateKey: other.private }));
  } finally {
    await srv.stop();
  }
});

test('SFTP/SCP: exige contraseña o clave', async () => {
  await assert.rejects(new SftpServer(cfg('sftp', { username: 'nexus', password: '' }), state).start(), /contraseña o al menos una clave/);
});

test('SFTP y SCP con curl (libssh)', { skip: !(curlHas('sftp') && curlHas('scp')) && 'curl sin SFTP/SCP' }, async () => {
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: 'clave' }), state);
  srv.on('log', (e: ServerLogEntry) => e.level === 'error' && console.log('[sftp]', e.message));
  await srv.start();
  const port = srv.boundPort()!;
  const base = ['-k', '-u', 'nexus:clave'];
  try {
    let r = await curl([...base, `sftp://127.0.0.1:${port}/configs/switch1.cfg`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'hostname sw1\n');
    const dl = join(tmpdir(), `nexus-scp-dl-${Date.now()}`);
    r = await curl([...base, '-o', dl, `scp://127.0.0.1:${port}/firmware.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(dl).equals(firmware));
    const up = join(tmpdir(), `nexus-scp-up-${Date.now()}`);
    writeFileSync(up, 'interface Gi0/1\n shutdown\n');
    r = await curl([...base, '-T', up, `scp://127.0.0.1:${port}/configs/router.cfg`]);
    assert.equal(r.code, 0, r.err);
    // Algunas versiones de curl cierran sin esperar la última confirmación SCP: el servidor
    // termina de guardar el archivo justo después de que curl salga.
    for (let i = 0; i < 100 && !existsSync(join(root, 'configs', 'router.cfg')); i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(readFileSync(join(root, 'configs', 'router.cfg'), 'utf8'), 'interface Gi0/1\n shutdown\n');
    r = await curl([...base, '-T', up, '--ftp-create-dirs', `sftp://127.0.0.1:${port}/sftp-curl/x.cfg`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(root, 'sftp-curl', 'x.cfg')));
  } finally {
    await srv.stop();
  }
});

test('SCP: recepción recursiva y envío recursivo (protocolo a mano)', async () => {
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: 'clave' }), state);
  await srv.start();
  const c = await sshConnect(srv.boundPort()!, { password: 'clave' });
  try {
    // Recepción: scp -r -t /recibido
    await new Promise<void>((resolve, reject) => c.exec('scp -r -t /recibido', (e, ch) => {
      if (e) return reject(e);
      const acks: number[] = [];
      const steps = [
        'D0755 0 backups\n', 'C0644 4 a.cfg\n', Buffer.from('hola\0'), 'D0755 0 sub\n', 'C0600 3 b.cfg\n', Buffer.from('xyz\0'), 'E\n', 'E\n',
      ];
      ch.on('data', (d: Buffer) => {
        for (const b of d) {
          acks.push(b);
          const next = steps.shift();
          if (next === undefined) ch.end();
          else ch.write(next);
        }
      });
      ch.on('exit', (code: number) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    }));
    // /recibido no existía: la carpeta «backups» pasa a llamarse «recibido», como en OpenSSH.
    assert.equal(readFileSync(join(root, 'recibido', 'a.cfg'), 'utf8'), 'hola');
    assert.equal(readFileSync(join(root, 'recibido', 'sub', 'b.cfg'), 'utf8'), 'xyz');

    // Envío: scp -r -f /configs
    const got = await new Promise<string>((resolve, reject) => c.exec('scp -r -f /configs', (e, ch) => {
      if (e) return reject(e);
      let text = '';
      ch.on('data', (d: Buffer) => {
        text += d.toString('latin1');
        if (/\n$|\0$/.test(text)) ch.write('\0');
      });
      ch.write('\0');
      ch.on('close', () => resolve(text));
    }));
    assert.match(got, /^D0\d{3} 0 configs\n/);
    assert.match(got, /C0\d{3} 13 switch1\.cfg\nhostname sw1\n\0/);
    assert.match(got, /E\n$/);
  } finally {
    c.end();
    await srv.stop();
  }
});

test('SCP: «..» en el nombre se rechaza', async () => {
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: 'clave' }), state);
  await srv.start();
  const c = await sshConnect(srv.boundPort()!, { password: 'clave' });
  try {
    const reply = await new Promise<string>((resolve) => c.exec('scp -t /', (_e, ch) => {
      let d = '';
      let sent = false;
      ch.on('data', (x: Buffer) => {
        d += x.toString('latin1');
        if (!sent) {
          sent = true;
          ch.write('C0644 4 ..\n');
        }
      });
      ch.on('close', () => resolve(d));
    }));
    assert.match(reply, /\x02scp: nombre/);
  } finally {
    c.end();
    await srv.stop();
  }
});

// ------------------------------------------------------------------- DHCP
const MAC_A = Buffer.from('aabbcc000001', 'hex');
const MAC_B = Buffer.from('aabbcc000002', 'hex');

function clientPacket(type: number, mac: Buffer, opts: Record<number, Buffer> = {}, extra: Record<string, unknown> = {}): Buffer {
  const chaddr = Buffer.alloc(16);
  mac.copy(chaddr);
  const options = new Map<number, Buffer>([[53, Buffer.from([type])], ...Object.entries(opts).map(([k, v]) => [Number(k), v] as [number, Buffer])]);
  return buildPacket({ op: 1, xid: 0x1234, chaddr, flags: 0x8000, options, ...extra });
}
const ip4 = (ip: string) => { const b = Buffer.alloc(4); b.writeUInt32BE(ipToInt(ip)); return b; };

const dhcpCfg = (extra: Partial<ServerConfig> = {}) => cfg('dhcp', {
  dhcpPoolStart: '10.9.0.100', dhcpPoolEnd: '10.9.0.102', dhcpSubnetMask: '255.255.255.0', dhcpRouter: '10.9.0.1',
  dhcpDns: '1.1.1.1, 9.9.9.9', dhcpDomain: 'lab.local', dhcpLeaseSecs: 3600, dhcpTftpServer: '10.9.0.5', dhcpBootFile: 'phone.cfg', ...extra,
});

test('DHCP: validación de la configuración', () => {
  assert.throws(() => dhcpSettings(dhcpCfg({ dhcpPoolEnd: '10.9.1.5' }), '10.9.0.5'), /misma subred/);
  assert.throws(() => dhcpSettings(dhcpCfg({ dhcpPoolStart: '10.9.0.200' }), '10.9.0.5'), /mayor que el final/);
  assert.throws(() => dhcpSettings(dhcpCfg({ dhcpSubnetMask: '255.0.255.0' }), '10.9.0.5'), /máscara/);
  assert.throws(() => dhcpSettings(dhcpCfg({ dhcpDns: '1.1.1' }), '10.9.0.5'), /DNS/);
  assert.throws(() => dhcpSettings(dhcpCfg({ dhcpPoolEnd: '10.9.0.255' }), '10.9.0.5'), /difusión/);
  assert.equal(intToIp(ipToInt('192.168.1.254')), '192.168.1.254');
});

test('DHCP: DISCOVER → OFFER → REQUEST → ACK con todas las opciones', () => {
  let now = 1_000_000;
  const e = new DhcpEngine(dhcpSettings(dhcpCfg(), '10.9.0.5'), () => now);
  const offer = e.handle(parsePacket(clientPacket(MSG.DISCOVER, MAC_A, { 12: Buffer.from('telefono1') }))!);
  assert.equal(offer.type, MSG.OFFER);
  const o = parsePacket(offer.reply!)!;
  assert.equal(o.op, 2);
  assert.equal(o.xid, 0x1234);
  assert.equal(o.yiaddr, '10.9.0.100');
  assert.equal(o.file, 'phone.cfg');
  assert.equal(intToIp(o.options.get(1)!.readUInt32BE(0)), '255.255.255.0');
  assert.equal(intToIp(o.options.get(3)!.readUInt32BE(0)), '10.9.0.1');
  assert.equal(o.options.get(6)!.length, 8);
  assert.equal(o.options.get(15)!.toString(), 'lab.local');
  assert.equal(o.options.get(51)!.readUInt32BE(0), 3600);
  assert.equal(intToIp(o.options.get(54)!.readUInt32BE(0)), '10.9.0.5');
  assert.equal(o.options.get(66)!.toString(), '10.9.0.5');
  assert.equal(o.options.get(67)!.toString(), 'phone.cfg');

  // Otro cliente recibe otra IP mientras la oferta está reservada.
  const offerB = parsePacket(e.handle(parsePacket(clientPacket(MSG.DISCOVER, MAC_B))!).reply!)!;
  assert.equal(offerB.yiaddr, '10.9.0.101');

  const ack = e.handle(parsePacket(clientPacket(MSG.REQUEST, MAC_A, { 50: ip4('10.9.0.100'), 54: ip4('10.9.0.5') }))!);
  assert.equal(ack.type, MSG.ACK);
  assert.equal(parsePacket(ack.reply!)!.yiaddr, '10.9.0.100');
  assert.match(ack.log!, /Concede 10\.9\.0\.100 a aa:bb:cc:00:00:01 \(telefono1\)/);
  assert.deepEqual(e.list().map((l) => l.ip), ['10.9.0.100', '10.9.0.101']);

  // B pide la IP de A: NAK.
  const nak = e.handle(parsePacket(clientPacket(MSG.REQUEST, MAC_B, { 50: ip4('10.9.0.100'), 54: ip4('10.9.0.5') }))!);
  assert.equal(nak.type, MSG.NAK);

  // B eligió otro servidor: se libera su oferta y no se responde.
  assert.equal(e.handle(parsePacket(clientPacket(MSG.REQUEST, MAC_B, { 50: ip4('10.9.0.101'), 54: ip4('10.9.0.250') }))!).reply, null);
  assert.deepEqual(e.list().map((l) => l.mac), ['aa:bb:cc:00:00:01']);

  // Renovación (cliente con IP, sin server id).
  now += 1000;
  const renew = e.handle(parsePacket(clientPacket(MSG.REQUEST, MAC_A, {}, { ciaddr: '10.9.0.100', flags: 0 }))!);
  assert.equal(renew.type, MSG.ACK);
  assert.match(renew.log!, /Renueva/);

  // Al reiniciar, A vuelve a recibir la misma IP.
  assert.equal(parsePacket(e.handle(parsePacket(clientPacket(MSG.DISCOVER, MAC_A))!).reply!)!.yiaddr, '10.9.0.100');

  // RELEASE libera.
  e.handle(parsePacket(clientPacket(MSG.RELEASE, MAC_A, {}, { ciaddr: '10.9.0.100' }))!);
  assert.equal(e.list().length, 0);
});

test('DHCP: reservas, DECLINE y rango agotado', () => {
  const now = 5_000_000;
  const e = new DhcpEngine(dhcpSettings(dhcpCfg({ dhcpReservations: [{ mac: 'AA-BB-CC-00-00-09', ip: '10.9.0.50', name: 'impresora' }] }), '10.9.0.5'), () => now);
  const resMac = Buffer.from('aabbcc000009', 'hex');
  assert.equal(parsePacket(e.handle(parsePacket(clientPacket(MSG.DISCOVER, resMac))!).reply!)!.yiaddr, '10.9.0.50');
  assert.equal(e.handle(parsePacket(clientPacket(MSG.REQUEST, resMac, { 50: ip4('10.9.0.50') }))!).type, MSG.ACK);
  assert.ok(e.list().some((l) => l.ip === '10.9.0.50' && l.reserved));

  // DECLINE: la IP queda apartada.
  e.handle(parsePacket(clientPacket(MSG.DISCOVER, MAC_A))!);
  e.handle(parsePacket(clientPacket(MSG.DECLINE, MAC_A, { 50: ip4('10.9.0.100') }))!);
  assert.equal(parsePacket(e.handle(parsePacket(clientPacket(MSG.DISCOVER, MAC_A))!).reply!)!.yiaddr, '10.9.0.101');

  // Rango de 3 IP, una declinada y otra ofrecida a A: el tercer cliente recibe la última y el cuarto nada.
  const c3 = Buffer.from('aabbcc000003', 'hex');
  const c4 = Buffer.from('aabbcc000004', 'hex');
  assert.equal(parsePacket(e.handle(parsePacket(clientPacket(MSG.DISCOVER, c3))!).reply!)!.yiaddr, '10.9.0.102');
  const none = e.handle(parsePacket(clientPacket(MSG.DISCOVER, c4))!);
  assert.equal(none.reply, null);
  assert.match(none.log!, /Sin direcciones libres/);
});

test('DHCP: servidor por UDP con concesiones persistentes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-dhcp-'));
  const conf = dhcpCfg({ rootDir: dir, dhcpPoolStart: '127.0.0.100', dhcpPoolEnd: '127.0.0.110', dhcpRouter: '127.0.0.1', dhcpTftpServer: '' });
  const client = createSocket('udp4');
  await new Promise<void>((r) => client.bind(0, '127.0.0.1', () => r()));
  const srv = new DhcpServer(conf, state);
  srv.clientPort = client.address().port;
  const statuses: number[] = [];
  srv.on('status', () => statuses.push(srv.details().leases?.length ?? -1));
  await srv.start();
  const exchange = (pkt: Buffer) => new Promise<ReturnType<typeof parsePacket>>((resolve) => {
    client.once('message', (m) => resolve(parsePacket(m)));
    client.send(pkt, srv.boundPort()!, '127.0.0.1');
  });
  try {
    const offer = (await exchange(clientPacket(MSG.DISCOVER, MAC_A)))!;
    assert.equal(offer.options.get(53)![0], MSG.OFFER);
    assert.equal(offer.yiaddr, '127.0.0.100');
    const ack = (await exchange(clientPacket(MSG.REQUEST, MAC_A, { 50: ip4(offer.yiaddr), 54: ip4('127.0.0.1') })))!;
    assert.equal(ack.options.get(53)![0], MSG.ACK);
    assert.equal(srv.details().leases!.length, 1);
  } finally {
    await srv.stop();
    client.close();
  }
  const saved = JSON.parse(readFileSync(join(dir, 'concesiones-dhcp.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ip, '127.0.0.100');
  // Tras reiniciar se recuerda la concesión.
  const again = new DhcpServer(conf, state);
  await again.start();
  assert.equal(again.details().leases!.length, 1);
  await again.stop();
});

test('DHCP: error claro si ninguna interfaz está en la red del rango', async () => {
  const srv = new DhcpServer(dhcpCfg({ bindHost: '0.0.0.0', dhcpPoolStart: '203.0.113.10', dhcpPoolEnd: '203.0.113.20' }), state);
  await assert.rejects(srv.start(), /Ninguna interfaz/);
});

// Clientes reales de OpenSSH (si están instalados): scp moderno (SFTP), scp -O (protocolo clásico) y sftp.
let hasOpenSsh = false;
try {
  execFileSync('scp', ['-h'], { stdio: 'ignore' });
} catch (e) {
  hasOpenSsh = (e as NodeJS.ErrnoException).code !== 'ENOENT';
}

test('SFTP/SCP con OpenSSH (scp, scp -O -r, sftp)', { skip: !hasOpenSsh && 'sin cliente OpenSSH' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-openssh-'));
  const keyPath = join(dir, 'id');
  const pair = generateKeyPairChecked('ed25519');
  writeFileSync(keyPath, pair.private, { mode: 0o600 });
  const srv = new SftpServer(cfg('sftp', { username: 'nexus', password: '', authorizedKeys: pair.public }), state);
  await srv.start();
  const opts = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-i', keyPath, '-P', String(srv.boundPort())];
  const run = (cmd: string, args: string[], input?: string) => new Promise<{ code: number; err: string }>((resolve) => {
    const child = execFile(cmd, args, { timeout: 20000 }, (e, _o, err) => resolve({ code: e ? ((e as any).code ?? 1) : 0, err }));
    if (input !== undefined) child.stdin!.end(input);
  });
  try {
    // Las carpetas intermedias se crean solas, como en TFTP y HTTP PUT.
    let r = await run('scp', [...opts, join(root, 'firmware.bin'), 'nexus@127.0.0.1:/openssh/fw-sftp.bin']);
    assert.equal(r.code, 0, r.err);
    r = await run('scp', ['-O', ...opts, join(root, 'firmware.bin'), 'nexus@127.0.0.1:/openssh/fw-scp.bin']);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(join(root, 'openssh', 'fw-sftp.bin')).equals(firmware));
    assert.ok(readFileSync(join(root, 'openssh', 'fw-scp.bin')).equals(firmware));
    r = await run('scp', ['-O', '-r', ...opts, 'nexus@127.0.0.1:/configs', join(dir, 'bajada')]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(dir, 'bajada', 'switch1.cfg'), 'utf8'), 'hostname sw1\n');
    const sftpOpts = opts.filter((o) => o !== '-P' && o !== String(srv.boundPort()));
    r = await run('sftp', ['-b', '-', '-P', String(srv.boundPort()), ...sftpOpts, 'nexus@127.0.0.1'], 'cd openssh\nrename fw-scp.bin fw2.bin\nrm fw-sftp.bin\nls\n');
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(root, 'openssh', 'fw2.bin')));
    assert.ok(!existsSync(join(root, 'openssh', 'fw-sftp.bin')));
  } finally {
    await srv.stop();
  }
});
