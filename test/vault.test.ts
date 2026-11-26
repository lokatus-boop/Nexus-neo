import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/main/vault';

const file = () => join(mkdtempSync(join(tmpdir(), 'nexus-vault-')), 'vault.json');

test('crea, guarda y recupera secretos cifrados', async () => {
  const f = file();
  const v = new Vault(f);
  assert.equal(await v.exists(), false);
  await v.create('contraseña-maestra');
  await v.set('s1', { password: 'SuperSecreta123' });
  assert.equal(v.get('s1')?.password, 'SuperSecreta123');
  const raw = readFileSync(f, 'utf8');
  assert.ok(!raw.includes('SuperSecreta123'), 'el archivo no debe contener el secreto en claro');

  const v2 = new Vault(f);
  await v2.unlock('contraseña-maestra');
  assert.equal(v2.get('s1')?.password, 'SuperSecreta123');
});

test('rechaza contraseñas maestras incorrectas y cortas', async () => {
  const f = file();
  const v = new Vault(f);
  await assert.rejects(v.create('corta'), /8 caracteres/);
  await v.create('correcta-123');
  const v2 = new Vault(f);
  await assert.rejects(v2.unlock('incorrecta'), /incorrecta/);
  assert.equal(v2.isUnlocked(), false);
});

test('bloquear borra la clave de memoria', async () => {
  const v = new Vault(file());
  await v.create('correcta-123');
  v.lock();
  assert.equal(v.isUnlocked(), false);
  assert.throws(() => v.get('x'), /bloqueada/);
});

test('cambiar la contraseña maestra conserva los secretos', async () => {
  const f = file();
  const v = new Vault(f);
  await v.create('antigua-123');
  await v.set('a', { passphrase: 'frase' });
  await v.changePassword('antigua-123', 'nueva-4567');
  const v2 = new Vault(f);
  await assert.rejects(v2.unlock('antigua-123'));
  await v2.unlock('nueva-4567');
  assert.equal(v2.get('a')?.passphrase, 'frase');
});

test('detecta manipulación del archivo (GCM)', async () => {
  const f = file();
  const v = new Vault(f);
  await v.create('correcta-123');
  await v.set('a', { password: 'x' });
  const data = JSON.parse(readFileSync(f, 'utf8'));
  const buf = Buffer.from(data.data, 'base64');
  buf[0] ^= 0xff;
  data.data = buf.toString('base64');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(f, JSON.stringify(data));
  await assert.rejects(new Vault(f).unlock('correcta-123'));
});
