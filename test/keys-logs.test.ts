import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { generateKey, listKeys, validatePublicKey } from '../src/main/keys';
import { stripAnsi, logFileName, SessionLogger } from '../src/main/session-log';

test('stripAnsi elimina colores, OSC y retornos sueltos', () => {
  const raw = '\x1b]0;titulo\x07\x1b[1;32muser@host\x1b[0m:~$ ls\r\n100%\rlisto\x07';
  assert.equal(stripAnsi(raw), 'user@host:~$ ls\r\n100%listo');
});

test('logFileName genera rutas seguras por día', () => {
  const r = logFileName('prod / web:01', new Date(2026, 0, 5, 9, 3, 7));
  assert.equal(r.day, '2026-01-05');
  assert.equal(r.file, 'prod_web_01_090307.log');
});

test('SessionLogger escribe cabecera, datos y pie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-log-'));
  try {
    const log = new SessionLogger(dir, 'srv', true);
    log.write('\x1b[31mhola\x1b[0m\n');
    await new Promise<void>((res) => { (log as any).stream.on('finish', res); log.close(); });
    const txt = readFileSync(log.path, 'utf8');
    assert.match(txt, /^# Nexus Neo · srv/);
    assert.match(txt, /\nhola\n/);
    assert.match(txt, /# Fin de sesión/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('genera claves ed25519 cifradas y las lista', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-keys-'));
  try {
    const info = await generateKey({ type: 'ed25519', comment: 'prueba@nexus', passphrase: 'secreta', path: join(dir, 'id_test') });
    assert.equal(info.type, 'ssh-ed25519');
    assert.equal(info.comment, 'prueba@nexus');
    assert.match(info.fingerprint, /^SHA256:/);
    const priv = readFileSync(join(dir, 'id_test'), 'utf8');
    assert.ok(utils.parseKey(priv) instanceof Error, 'sin frase no debe poder leerse');
    assert.ok(!(utils.parseKey(priv, 'secreta') instanceof Error));
    await assert.rejects(generateKey({ type: 'ed25519', path: join(dir, 'id_test') }), /Ya existe/);
    const keys = await listKeys(dir);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].fingerprint, info.fingerprint);
    assert.equal(validatePublicKey(info.publicKey + '  '), info.publicKey);
    assert.throws(() => validatePublicKey('no es una clave'), /formato/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
