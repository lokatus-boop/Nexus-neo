import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';
import { Store } from '../src/main/store';
import { Vault } from '../src/main/vault';
import { SyncManager } from '../src/main/sync-manager';
import { SYNC_FILE, SftpTarget, decryptBundle, emptyBundle, encryptBundle, mergeCollection, syncOnce } from '../src/main/sync';
import { startTestServer } from './helpers/ssh-server';
import type { SessionConfig } from '../src/shared/types';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('Sincronización: el archivo va cifrado y detecta frase incorrecta o manipulación', () => {
  const b = { ...emptyBundle(), collections: { sessions: [{ id: 'a', updatedAt: 1, host: 'secreto.ejemplo.com' }] } };
  const text = encryptBundle(b, 'frase-larga-1');
  assert.ok(!text.includes('secreto.ejemplo.com'));
  assert.deepEqual(decryptBundle(text, 'frase-larga-1').collections, b.collections);
  assert.throws(() => decryptBundle(text, 'otra-frase-xx'), /incorrecta|manipulado/);
  const raw = JSON.parse(text);
  raw.data = Buffer.from(Buffer.from(raw.data, 'base64').map((x: number, i: number) => (i === 5 ? x ^ 1 : x))).toString('base64');
  assert.throws(() => decryptBundle(JSON.stringify(raw), 'frase-larga-1'), /incorrecta|manipulado/);
  assert.throws(() => encryptBundle(b, 'corta'), /8 caracteres/);
});

test('Sincronización: gana la versión más reciente y los borrados se propagan', () => {
  const local = [{ id: 'a', updatedAt: 10, v: 'local' }, { id: 'b', updatedAt: 50, v: 'local' }, { id: 'c', updatedAt: 5, v: 'local' }];
  const remote = [{ id: 'a', updatedAt: 20, v: 'remoto' }, { id: 'b', updatedAt: 40, v: 'remoto' }, { id: 'd', updatedAt: 1, v: 'remoto' }];
  const { items, stats } = mergeCollection('x', local, remote, { 'x:c': 7, 'x:d': 2 });
  assert.deepEqual(items.map((i) => `${i.id}:${i.v}`), ['a:remoto', 'b:local']);
  assert.deepEqual(stats, { added: 0, updated: 1, removed: 1 });
  // Si el elemento se volvió a editar después de borrarlo en otro equipo, se conserva.
  const r2 = mergeCollection('x', [{ id: 'c', updatedAt: 9 }], [], { 'x:c': 7 });
  assert.equal(r2.items.length, 1);
});

function machine(shared: string, name: string) {
  const store = new Store(tmp(`nexus-sync-${name}-`));
  const vault = new Vault(join(store.dir, 'vault.json'));
  const mgr = new SyncManager({
    store,
    vault,
    collections: [
      { name: 'sessions', list: () => store.listSessions(), replace: (l) => store.replaceSessions(l as SessionConfig[]) },
      { name: 'macros', list: () => store.listMacros(), replace: (l) => store.replaceMacros(l as never) },
    ],
    openSftp: async () => {
      throw new Error('no usado');
    },
  });
  return { store, vault, mgr, init: async () => {
    await store.init();
    await vault.create('maestra-de-' + name);
    await store.saveSettings({ sync: { enabled: true, mode: 'folder', path: shared, includeSecrets: true, intervalMin: 0, deviceName: name } });
    await mgr.setPassphrase('frase-compartida');
  } };
}

test('Sincronización: dos equipos comparten sesiones, macros, contraseñas y borrados por una carpeta', async () => {
  const shared = tmp('nexus-sync-nube-');
  const a = machine(shared, 'portatil');
  const b = machine(shared, 'sobremesa');
  await a.init();
  await b.init();

  const s1 = await a.store.saveSession({ id: '', name: 'Router', folder: 'Red', kind: 'ssh', host: '10.0.0.1' });
  await a.vault.set(s1.id, { password: 'clave-router' });
  await a.store.saveMacro({ id: '', name: 'Guardar', body: 'write mem\\n' });
  const st = await a.mgr.run();
  assert.equal(st.lastError, undefined);
  assert.ok(!readFileSync(join(shared, SYNC_FILE), 'utf8').includes('clave-router'));

  await b.mgr.run();
  assert.deepEqual((await b.store.listSessions()).map((s) => s.name), ['Router']);
  assert.equal((await b.store.listMacros())[0].name, 'Guardar');
  assert.equal(b.vault.get(s1.id)?.password, 'clave-router');
  assert.deepEqual((await b.mgr.getStatus()).lastResult?.devices.sort(), ['portatil', 'sobremesa']);

  // Edición en B y nueva sesión en A al mismo tiempo: no se pierde nada.
  await new Promise((r) => setTimeout(r, 5));
  await b.store.saveSession({ ...(await b.store.listSessions())[0], host: '10.0.0.254' });
  await a.store.saveSession({ id: '', name: 'Switch', folder: 'Red', kind: 'telnet', host: '10.0.0.2' });
  await b.mgr.run();
  await a.mgr.run();
  await b.mgr.run();
  for (const m of [a, b]) {
    const list = await m.store.listSessions();
    assert.deepEqual(list.map((s) => `${s.name}@${s.host}`).sort(), ['Router@10.0.0.254', 'Switch@10.0.0.2']);
  }

  // Borrado en A: desaparece en B.
  await a.store.deleteSession(s1.id);
  await a.mgr.run();
  await b.mgr.run();
  assert.deepEqual((await b.store.listSessions()).map((s) => s.name), ['Switch']);

  // Otra frase: error claro y sin tocar los datos.
  await b.mgr.setPassphrase('frase-equivocada');
  await assert.rejects(b.mgr.run(), /incorrecta/);
  assert.equal((await b.store.listSessions()).length, 1);
});

test('Sincronización por SFTP en un servidor SSH', async () => {
  const root = tmp('nexus-sync-sftp-');
  const srv = await startTestServer(root);
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve()).once('error', reject).connect({ host: '127.0.0.1', port: srv.port, username: 'nexus', password: 'secreto' });
  });
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((r, j) => client.sftp((e, s) => (e ? j(e) : r(s))));
  const target = new SftpTarget(async () => sftp, '/nexus', 'servidor');
  const first = await syncOnce(target, 'frase-compartida', { collections: { sessions: [{ id: 'x', updatedAt: 3 }] }, deleted: {} }, 'equipo1');
  assert.equal(first.created, true);
  const second = await syncOnce(target, 'frase-compartida', { collections: { sessions: [] }, deleted: {} }, 'equipo2');
  assert.equal(second.stats.added, 1);
  assert.deepEqual(second.bundle.collections.sessions.map((s) => s.id), ['x']);
  assert.ok(readFileSync(join(root, 'nexus', SYNC_FILE), 'utf8').startsWith('{"format":"nexus-neo-sync"'));
  client.end();
  await srv.close();
  writeFileSync(join(root, 'ok'), '');
});
