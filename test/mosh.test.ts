import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createCipheriv, getCiphers, randomBytes } from 'node:crypto';
import { Ocb } from '../src/main/protocols/mosh/ocb';
import {
  MAX_U64, decodeHostMessage, decodeInstruction, decodeUserMessage, encodeHostMessage, encodeInstruction, encodeUserMessage,
} from '../src/main/protocols/mosh/proto';
import { MoshTransport, parseMoshConnect, parseMoshKey } from '../src/main/protocols/mosh/transport';
import { moshServerCommand } from '../src/main/protocols/mosh';

const hex = (s: string) => Buffer.from(s, 'hex');

test('OCB3: vectores de prueba de RFC 7253 (AES-128, etiqueta de 128 bits)', () => {
  const ocb = new Ocb(hex('000102030405060708090A0B0C0D0E0F'));
  const n = (last: string) => hex(`BBAA998877665544332211${last}`);
  const p8 = hex('0001020304050607');
  const p16 = hex('000102030405060708090A0B0C0D0E0F');
  assert.equal(ocb.encrypt(n('00'), Buffer.alloc(0)).toString('hex').toUpperCase(), '785407BFFFC8AD9EDCC5520AC9111EE6');
  assert.equal(ocb.encrypt(n('01'), p8, p8).toString('hex').toUpperCase(), '6820B3657B6F615A5725BDA0D3B4EB3A257C9AF1F8F03009');
  assert.equal(ocb.encrypt(n('02'), Buffer.alloc(0), p8).toString('hex').toUpperCase(), '81017F8203F081277152FADE694A0A00');
  assert.equal(ocb.encrypt(n('03'), p8).toString('hex').toUpperCase(), '45DD69F8F5AAE72414054CD1F35D82760B2CD00D2F99BFA9');
  assert.equal(ocb.encrypt(n('04'), p16, p16).toString('hex').toUpperCase(), '571D535B60B277188BE5147170A9A22C3AD7A4FF3835B8C5701C1CCEC8FC3358');
  const ct = ocb.encrypt(n('03'), p8);
  assert.deepEqual(ocb.decrypt(n('03'), ct), p8);
  ct[3] ^= 1;
  assert.equal(ocb.decrypt(n('03'), ct), null, 'un byte alterado debe invalidar la etiqueta');
});

test('OCB3: coincide con la implementación nativa de OpenSSL (si existe)', { skip: !getCiphers().includes('aes-128-ocb') }, () => {
  for (let t = 0; t < 300; t++) {
    const key = randomBytes(16);
    const nonce = randomBytes(12);
    const pt = randomBytes(t % 97);
    const c = createCipheriv('aes-128-ocb', key, nonce, { authTagLength: 16 });
    const ref = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    assert.deepEqual(new Ocb(key).encrypt(nonce, pt), ref);
  }
});

test('Mosh: protobuf de instrucciones, teclas y pantalla', () => {
  const inst = { protocolVersion: 2, oldNum: 3n, newNum: MAX_U64, ackNum: 7n, throwawayNum: 3n, diff: Buffer.from('x'), chaff: Buffer.alloc(0) };
  assert.deepEqual(decodeInstruction(encodeInstruction(inst)), inst);
  const user = encodeUserMessage([{ type: 'keys', data: Buffer.from('l') }, { type: 'keys', data: Buffer.from('s') }, { type: 'resize', width: 120, height: 40 }]);
  assert.deepEqual(decodeUserMessage(user), [{ type: 'keys', data: Buffer.from('ls') }, { type: 'resize', width: 120, height: 40 }]);
  const host = [{ type: 'echoack' as const, num: 5n }, { type: 'resize' as const, width: 80, height: 24 }, { type: 'bytes' as const, data: Buffer.from('\x1b[H hola') }];
  assert.deepEqual(decodeHostMessage(encodeHostMessage(host)), host);
});

test('Mosh: interpreta MOSH CONNECT y valida la clave', () => {
  assert.deepEqual(parseMoshConnect('\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\r\n\nmosh-server (mosh 1.4.0)'), { port: 60001, key: '4NeCCgvZFe2RnPgrcU1PQw' });
  assert.equal(parseMoshConnect('bash: mosh-server: command not found'), null);
  assert.equal(parseMoshKey('4NeCCgvZFe2RnPgrcU1PQw').length, 16);
  assert.throws(() => parseMoshKey('corta'));
  assert.equal(
    moshServerCommand({ id: 'x', name: 'x', folder: '', kind: 'mosh', moshPorts: '60000:60010', moshCommand: 'tmux new -A -s main' }),
    "mosh-server new -s -c 256 -l LANG=C.UTF-8 -p 60000:60010 -- tmux new -A -s main",
  );
  assert.equal(moshServerCommand({ id: 'x', name: 'x', folder: '', kind: 'mosh', moshServer: "/opt/mosh bin/mosh-server" }), "'/opt/mosh bin/mosh-server' new -s -c 256 -l LANG=C.UTF-8");
});

let hasMosh = false;
try {
  execFileSync('mosh-server', ['--version'], { stdio: 'ignore' });
  hasMosh = true;
} catch {
  /* sin mosh-server */
}

function startMoshServer(script: string): Promise<{ port: number; key: string }> {
  return new Promise((resolve, reject) => {
    execFile('mosh-server', ['new', '-i', '127.0.0.1', '-c', '256', '-l', 'LANG=C.UTF-8', '--', '/bin/sh', '-c', script], { timeout: 10000 }, (err, out, errOut) => {
      const r = parseMoshConnect(`${out}\n${errOut}`);
      if (r) resolve(r);
      else reject(err || new Error(`mosh-server no arrancó: ${out} ${errOut}`));
    });
  });
}

test('Mosh: sesión real contra mosh-server (teclas, pantalla, cambio de red, redimensionar y cierre)', { skip: !hasMosh && 'mosh-server no está instalado' }, async () => {
  const srv = await startMoshServer('printf "LISTO\\n"; read x; printf "leido:%s\\n" "$x"; stty size; read y; echo FIN; sleep 0.3');
  const t = new MoshTransport({ host: '127.0.0.1', port: srv.port, key: srv.key });
  let screen = '';
  const waitFor = (text: string, ms = 8000) => new Promise<void>((resolve, reject) => {
    const end = setTimeout(() => reject(new Error(`no llegó "${text}". Pantalla: ${JSON.stringify(screen)}`)), ms);
    const check = () => {
      if (screen.includes(text)) {
        clearTimeout(end);
        t.off('host', onHost);
        resolve();
      }
    };
    const onHost = () => check();
    t.on('host', onHost);
    check();
  });
  t.on('host', (d: Buffer) => (screen += d.toString('utf8')));
  const closed = new Promise<void>((r) => t.once('closed', () => r()));
  t.start();
  t.resize(100, 30);
  await waitFor('LISTO');
  // Cambio de red simulado: el cliente pasa a otro puerto UDP de origen y la sesión sigue.
  (t as unknown as { hopPort(): void }).hopPort();
  t.sendKeys(Buffer.from('hola mosh\r'));
  await waitFor('leido:hola mosh');
  await waitFor('30 100');
  t.sendKeys(Buffer.from('\r'));
  await waitFor('FIN');
  await closed; // el shell terminó: el servidor cierra la sesión limpiamente
});

test('Mosh: el cliente cierra la sesión del servidor al desconectar', { skip: !hasMosh && 'mosh-server no está instalado' }, async () => {
  const srv = await startMoshServer('echo VIVO; sleep 30');
  const t = new MoshTransport({ host: '127.0.0.1', port: srv.port, key: srv.key });
  let screen = '';
  t.on('host', (d: Buffer) => (screen += d.toString('utf8')));
  t.start();
  t.resize(80, 24);
  for (let i = 0; i < 80 && !screen.includes('VIVO'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(screen, /VIVO/);
  // El servidor debe terminar en cuanto recibe el cierre (antes de los 30 s del sleep).
  const alive = () => {
    try {
      execFileSync('pgrep', ['-f', 'mosh-server new .*echo VIVO; sleep 30'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(), 'mosh-server debería estar en marcha antes de cerrar');
  t.close();
  for (let i = 0; i < 50; i++) {
    if (!alive()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('mosh-server sigue escuchando tras cerrar la sesión');
});

test('Mosh: sesión completa arrancada por SSH (MoshConnection)', { skip: !hasMosh && 'mosh-server no está instalado' }, async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startTestServer } = await import('./helpers/ssh-server');
  const { MoshConnection } = await import('../src/main/protocols/mosh');
  const srv = await startTestServer(mkdtempSync(join(tmpdir(), 'nexus-mosh-')));
  const conn = new MoshConnection(
    { id: 'm1', name: 'mosh', folder: '', kind: 'mosh', host: '127.0.0.1', port: srv.port, username: 'nexus', auth: 'password', moshCommand: "sh -c 'echo SHELL_MOSH; read x; echo eco-$x; sleep 1'" },
    {
      prompter: { hostKey: async () => true, auth: async () => ['secreto'] },
      knownHosts: { get: () => undefined, set: async () => undefined },
      secretFor: () => ({ password: 'secreto' }),
      sessionById: () => undefined,
      onTunnelsChanged: () => undefined,
    },
  );
  let out = '';
  conn.on('data', (d: string) => (out += d));
  const states: string[] = [];
  conn.on('state', (s: string) => states.push(s));
  await conn.open(90, 25);
  assert.ok(states.includes('connected'));
  for (let i = 0; i < 50 && !out.includes('SHELL_MOSH'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /SHELL_MOSH/);
  conn.write('abc\r');
  for (let i = 0; i < 50 && !out.includes('eco-abc'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /eco-abc/);
  for (let i = 0; i < 50 && !states.includes('closed'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(states.includes('closed'), 'al terminar la orden remota se cierra la sesión');
  await srv.close();
});

test('Mosh: avisa si mosh-server no está instalado', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startTestServer } = await import('./helpers/ssh-server');
  const { MoshConnection } = await import('../src/main/protocols/mosh');
  const srv = await startTestServer(mkdtempSync(join(tmpdir(), 'nexus-mosh-')));
  const conn = new MoshConnection(
    { id: 'm2', name: 'mosh', folder: '', kind: 'mosh', host: '127.0.0.1', port: srv.port, username: 'nexus', auth: 'password', moshServer: 'no-existe-mosh-server' },
    {
      prompter: { hostKey: async () => true, auth: async () => ['secreto'] },
      knownHosts: { get: () => undefined, set: async () => undefined },
      secretFor: () => ({ password: 'secreto' }),
      sessionById: () => undefined,
      onTunnelsChanged: () => undefined,
    },
  );
  await assert.rejects(conn.open(80, 24), /mosh-server/);
  await srv.close();
});
