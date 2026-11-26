import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { TftpServer, parseRequest } from '../src/main/servers/tftp';
import { FtpServer } from '../src/main/servers/ftp';
import { HttpFileServer } from '../src/main/servers/http';
import { SyslogServer, parseSyslog, splitTcpFrames } from '../src/main/servers/syslog';
import { safeResolve } from '../src/main/servers/common';
import type { ServerConfig, ServerLogEntry } from '../src/shared/types';

let root: string;
const firmware = randomBytes(1_234_567);

function curl(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '--max-time', '20', ...args], { encoding: 'latin1', maxBuffer: 10 * 1024 * 1024 }, (e, out, err) =>
      resolve({ code: e ? ((e as any).code ?? 1) : 0, out, err }));
  });
}

import { execFileSync } from 'node:child_process';
let hasCurl = '';
try {
  hasCurl = execFileSync('curl', ['-V'], { encoding: 'utf8' });
} catch {
  /* sin curl */
}
const curlHas = (proto: string) => new RegExp(`Protocols:.*\\b${proto}\\b`).test(hasCurl);

const cfg = (kind: ServerConfig['kind'], extra: Partial<ServerConfig> = {}): ServerConfig => ({
  id: kind, kind, name: kind, rootDir: root, port: 0, bindHost: '127.0.0.1', allowWrite: true, ...extra,
});

before(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-srv-'));
  writeFileSync(join(root, 'firmware.bin'), firmware);
  mkdirSync(join(root, 'configs'));
  writeFileSync(join(root, 'configs', 'switch1.cfg'), 'hostname sw1\n');
});

test('safeResolve impide salir de la carpeta raíz', () => {
  assert.equal(safeResolve('/srv/x', 'a/b.txt'), join('/srv/x', 'a/b.txt'));
  assert.equal(safeResolve('/srv/x', '/a.txt'), join('/srv/x', 'a.txt'));
  assert.equal(safeResolve('/srv/x', '../etc/passwd'), null);
  assert.equal(safeResolve('/srv/x', 'a/../../x2'), null);
  assert.equal(safeResolve('/srv/x', '..\\..\\win.ini'), null);
});

test('TFTP: interpreta peticiones con opciones', () => {
  const pkt = Buffer.from('\x00\x01fw.bin\x00octet\x00blksize\x001468\x00tsize\x000\x00', 'latin1');
  assert.deepEqual(parseRequest(pkt), { op: 1, filename: 'fw.bin', mode: 'octet', options: { blksize: '1468', tsize: '0' } });
  assert.equal(parseRequest(Buffer.from([0, 9, 1])), null);
});

test('TFTP: descarga y subida con curl (con y sin blksize)', { skip: !curlHas('tftp') && 'curl sin TFTP' }, async () => {
  const srv = new TftpServer(cfg('tftp'));
  const logs: ServerLogEntry[] = [];
  srv.on('log', (e) => logs.push(e));
  await srv.start();
  const port = srv.boundPort()!;
  try {
    const out1 = join(root, 'dl1.bin');
    let r = await curl(['-o', out1, `tftp://127.0.0.1:${port}/firmware.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(out1).equals(firmware));

    const out2 = join(root, 'dl2.bin');
    r = await curl(['--tftp-blksize', '1468', '-o', out2, `tftp://127.0.0.1:${port}/firmware.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(out2).equals(firmware));

    const up = join(tmpdir(), `nexus-up-${Date.now()}.cfg`);
    writeFileSync(up, 'running-config\n'.repeat(500));
    r = await curl(['-T', up, `tftp://127.0.0.1:${port}/backup/router.cfg`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(root, 'backup', 'router.cfg'), 'utf8'), 'running-config\n'.repeat(500));

    r = await curl(['-o', join(root, 'x'), `tftp://127.0.0.1:${port}/no-existe.bin`]);
    assert.notEqual(r.code, 0);
    assert.ok(logs.some((l) => l.level === 'transfer' && l.message.includes('completada')));
  } finally {
    await srv.stop();
  }
});

test('TFTP: rechaza escritura si está deshabilitada', async () => {
  const srv = new TftpServer(cfg('tftp', { allowWrite: false }));
  await srv.start();
  const port = srv.boundPort()!;
  const sock = createSocket('udp4');
  const reply = await new Promise<Buffer>((resolve) => {
    sock.once('message', (m) => resolve(m));
    sock.send(Buffer.from('\x00\x02evil.bin\x00octet\x00', 'latin1'), port, '127.0.0.1');
  });
  sock.close();
  await srv.stop();
  assert.equal(reply.readUInt16BE(0), 5);
  assert.equal(reply.readUInt16BE(2), 2);
  assert.ok(!existsSync(join(root, 'evil.bin')));
});

test('FTP: login, listado, descarga, subida (pasivo y activo)', { skip: !curlHas('ftp') && 'curl sin FTP' }, async () => {
  const srv = new FtpServer(cfg('ftp', { username: 'admin', password: 'clave', pasvMin: 52000, pasvMax: 52100 }));
  await srv.start();
  const port = srv.boundPort()!;
  const base = `ftp://127.0.0.1:${port}`;
  try {
    let r = await curl(['-u', 'admin:mala', `${base}/`]);
    assert.notEqual(r.code, 0);

    r = await curl(['-u', 'admin:clave', `${base}/`]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /firmware\.bin/);
    assert.match(r.out, /^d.* configs\r?$/m);

    const out = join(root, 'ftp-dl.bin');
    r = await curl(['-u', 'admin:clave', '-o', out, `${base}/firmware.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(out).equals(firmware));

    // Modo activo (PORT/EPRT)
    const out2 = join(root, 'ftp-dl2.cfg');
    r = await curl(['-u', 'admin:clave', '-P', '127.0.0.1', '-o', out2, `${base}/configs/switch1.cfg`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(out2, 'utf8'), 'hostname sw1\n');

    const up = join(tmpdir(), `nexus-ftp-up-${Date.now()}.bin`);
    writeFileSync(up, firmware.subarray(0, 50_000));
    r = await curl(['-u', 'admin:clave', '-T', up, '--ftp-create-dirs', `${base}/subidas/img.bin`]);
    assert.equal(r.code, 0, r.err);
    assert.ok(readFileSync(join(root, 'subidas', 'img.bin')).equals(firmware.subarray(0, 50_000)));

    // Traversal
    r = await curl(['-u', 'admin:clave', '-o', join(root, 'p'), `${base}/../../../etc/hostname`]);
    assert.notEqual(r.code, 0);
  } finally {
    await srv.stop();
  }
});

test('FTP: acceso anónimo de sólo lectura', { skip: !curlHas('ftp') && 'curl sin FTP' }, async () => {
  const srv = new FtpServer(cfg('ftp', { anonymous: true, allowWrite: false, pasvMin: 52200, pasvMax: 52300 }));
  await srv.start();
  const base = `ftp://127.0.0.1:${srv.boundPort()}`;
  try {
    let r = await curl([`${base}/configs/switch1.cfg`]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'hostname sw1\n');
    const up = join(tmpdir(), `nexus-anon-${Date.now()}.txt`);
    writeFileSync(up, 'x');
    r = await curl(['-T', up, `${base}/x.txt`]);
    assert.notEqual(r.code, 0);
  } finally {
    await srv.stop();
  }
});

test('HTTP: listado, descarga con Range, PUT y traversal', async () => {
  const srv = new HttpFileServer(cfg('http'));
  await srv.start();
  const base = `http://127.0.0.1:${srv.boundPort()}`;
  try {
    const list = await fetch(`${base}/`);
    assert.match(await list.text(), /firmware\.bin/);
    const full = Buffer.from(await (await fetch(`${base}/firmware.bin`)).arrayBuffer());
    assert.ok(full.equals(firmware));
    const part = await fetch(`${base}/firmware.bin`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(firmware.subarray(100, 200)));
    const put = await fetch(`${base}/subido/nuevo.txt`, { method: 'PUT', body: 'hola' });
    assert.equal(put.status, 201);
    assert.equal(readFileSync(join(root, 'subido', 'nuevo.txt'), 'utf8'), 'hola');
    assert.equal((await fetch(`${base}/no-existe`)).status, 404);
    const raw = await new Promise<string>((resolve) => {
      const s = connect(srv.boundPort()!, '127.0.0.1', () => s.write('GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let d = '';
      s.on('data', (c) => (d += c));
      s.on('close', () => resolve(d));
    });
    assert.ok(!raw.includes('root:'), 'no debe servir archivos fuera de la raíz');
  } finally {
    await srv.stop();
  }
});

test('Syslog: recibe por UDP y TCP y guarda en archivo', async () => {
  assert.deepEqual(parseSyslog('<189>Nov 26 10:00:00 sw1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down'), {
    facility: 23, severity: 5, text: 'Nov 26 10:00:00 sw1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down',
  });
  assert.deepEqual(splitTcpFrames('12 <14>mensaje1<13>linea2\n<12>resto'), { messages: ['<14>mensaje1', '<13>linea2'], rest: '<12>resto' });

  const dir = mkdtempSync(join(tmpdir(), 'nexus-syslog-'));
  const srv = new SyslogServer(cfg('syslog', { rootDir: dir, syslogTcp: true, syslogToFile: true }));
  const got: ServerLogEntry[] = [];
  srv.on('log', (e) => e.level === 'syslog' && got.push(e));
  await srv.start();
  const port = srv.boundPort()!;
  const u = createSocket('udp4');
  await new Promise<void>((r) => u.send('<187>sw1: puerto caído', port, '127.0.0.1', () => r()));
  u.close();
  await new Promise<void>((r) => {
    const s = connect(port, '127.0.0.1', () => s.end('<14>router: mensaje tcp\n', () => r()));
  });
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  await srv.flush();
  await srv.stop();
  assert.equal(got.length, 2);
  assert.equal(got[0].syslog!.severity, 3);
  assert.equal(got[0].syslog!.text, 'sw1: puerto caído');
  const file = join(dir, `syslog-${new Date().toISOString().slice(0, 10)}.log`);
  const content = readFileSync(file, 'utf8');
  assert.match(content, /err sw1: puerto caído/);
  assert.match(content, /info router: mensaje tcp/);
});

after(() => undefined);
