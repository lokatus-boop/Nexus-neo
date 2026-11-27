import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  parseAclDump, evaluateAcl, checkKeyPermissions, checkKeyPermissionsMany, protectKeyFile, importKeyFile, manualFixHint, PsRunner,
} from '../src/main/key-perms';
import { generateKeyPairChecked, generateKey, listKeys } from '../src/main/keys';

const ME = 'S-1-5-21-111-222-333-1001';
const FULL = 2032127;
const READ = 1179785;

// Salida real (simplificada) del caso del usuario: la clave del escritorio con una ACE heredada
// para un grupo que no se puede traducir (UNKNOWN\UNKNOWN, S-1-5-32-513).
const DUMP_BAD = [
  `USER|${ME}`,
  'FILE|C:\\Users\\Portatil\\Desktop\\ssh-key-2026-08-19.key',
  `OWNER|${ME}`,
  `ACE|S-1-5-18|Allow|${FULL}|NT AUTHORITY\\SYSTEM`,
  `ACE|S-1-5-32-544|Allow|${FULL}|BUILTIN\\Administradores`,
  `ACE|${ME}|Allow|${FULL}|PORTATIL\\Portatil`,
  `ACE|S-1-5-32-513|Allow|${READ}|`,
  `ACE|S-1-1-0|Deny|${FULL}|Todos`,
  'FILE|C:\\otra.key',
  'ERROR|No se encuentra la ruta de acceso',
].join('\r\n');

test('parseAclDump separa archivos, propietario, ACE y errores', () => {
  const m = parseAclDump(DUMP_BAD);
  const d = m.get('C:\\Users\\Portatil\\Desktop\\ssh-key-2026-08-19.key');
  assert.ok(d && !(d instanceof Error));
  assert.equal(d.userSid, ME);
  assert.equal(d.ownerSid, ME);
  assert.equal(d.rules.length, 5);
  assert.deepEqual(d.rules[3], { sid: 'S-1-5-32-513', allow: true, rights: READ, name: '' });
  assert.equal(d.rules[4].allow, false);
  assert.ok(m.get('C:\\otra.key') instanceof Error);
});

test('evaluateAcl aplica las reglas de OpenSSH para Windows', () => {
  const d = parseAclDump(DUMP_BAD).get('C:\\Users\\Portatil\\Desktop\\ssh-key-2026-08-19.key') as ReturnType<typeof evaluateAcl> & any;
  const r = evaluateAcl(d);
  assert.equal(r.ok, false);
  assert.deepEqual(r.offenders, ['S-1-5-32-513']); // SYSTEM, Administradores, el usuario y las Deny no cuentan
  const good = evaluateAcl({ userSid: ME, ownerSid: ME, rules: [{ sid: ME, allow: true, rights: READ, name: '' }, { sid: 'S-1-5-18', allow: true, rights: FULL, name: '' }] });
  assert.deepEqual(good, { ok: true, offenders: [] });
  const owner = evaluateAcl({ userSid: ME, ownerSid: 'S-1-5-21-9-9-9-500', rules: [{ sid: ME, allow: true, rights: READ, name: '' }] });
  assert.equal(owner.ok, false);
  assert.equal(owner.badOwner, 'S-1-5-21-9-9-9-500');
  const named = evaluateAcl({ userSid: ME, rules: [{ sid: 'S-1-5-32-545', allow: true, rights: READ, name: 'BUILTIN\\Usuarios' }] });
  assert.deepEqual(named.offenders, ['BUILTIN\\Usuarios (S-1-5-32-545)']);
});

// PowerShell simulado: guarda una ACL por archivo y entiende los dos scripts del módulo.
function fakePowerShell(initial: Record<string, string[]>, opts: { failFix?: boolean } = {}) {
  const acl = new Map(Object.entries(initial));
  const calls: { script: string; env: Record<string, string> }[] = [];
  const run: PsRunner = async (script, env) => {
    calls.push({ script, env });
    if (env.NN_KEY_PATH) {
      if (opts.failFix) throw new Error('Acceso denegado.');
      acl.set(env.NN_KEY_PATH, [`ACE|${ME}|Allow|${FULL}|`, `ACE|S-1-5-18|Allow|${FULL}|`]);
      return 'OK\r\n';
    }
    const lines = [`USER|${ME}`];
    for (const p of env.NN_KEY_PATHS.split('\n')) lines.push(`FILE|${p}`, `OWNER|${ME}`, ...(acl.get(p) || []));
    return lines.join('\r\n');
  };
  return { run, calls, acl };
}

test('en Windows detecta y corrige una clave con permisos heredados', async () => {
  const path = 'C:\\Users\\Portatil\\Desktop\\ssh-key-2026-08-19.key';
  const ps = fakePowerShell({ [path]: [`ACE|${ME}|Allow|${FULL}|`, `ACE|S-1-5-32-513|Allow|${READ}|`] });
  const before = await checkKeyPermissions(path, { platform: 'win32', runPowerShell: ps.run });
  assert.equal(before.ok, false);
  const after = await protectKeyFile(path, { platform: 'win32', runPowerShell: ps.run });
  assert.equal(after.ok, true);
  const fix = ps.calls.find((c) => c.env.NN_KEY_PATH)!;
  // La ruta viaja por variable de entorno, nunca dentro del script.
  assert.ok(!fix.script.includes(path));
  assert.match(fix.script, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(fix.script, /\[System.IO.File\]::SetAccessControl\(\$p,\$acl\)/);
  assert.ok(!/Get-Acl|Set-Acl/.test(fix.script), 'sin cmdlets: pueden no cargar si hay PowerShell 7');
});

test('en Windows, si no se puede corregir, el error explica cómo hacerlo a mano', async () => {
  const path = 'C:\\claves\\srv.key';
  const ps = fakePowerShell({ [path]: [`ACE|S-1-5-32-545|Allow|${READ}|BUILTIN\\Usuarios`] }, { failFix: true });
  await assert.rejects(protectKeyFile(path, { platform: 'win32', runPowerShell: ps.run }), (e: Error) => {
    assert.match(e.message, /No se pudieron corregir los permisos de srv\.key: Acceso denegado/);
    assert.match(e.message, /icacls "C:\\claves\\srv\.key" \/inheritance:r/);
    assert.match(e.message, /\/grant:r "\$\(\$env:USERNAME\):\(R\)"/);
    return true;
  });
});

test('en Windows, si tras corregir sigue habiendo accesos, falla con detalle', async () => {
  const path = 'C:\\k';
  const run: PsRunner = async (_s, env) => (env.NN_KEY_PATH ? 'OK' : `USER|${ME}\nFILE|${path}\nACE|S-1-1-0|Allow|${READ}|Todos`);
  await assert.rejects(protectKeyFile(path, { platform: 'win32', runPowerShell: run }), /siguen teniendo acceso Todos \(S-1-1-0\)/);
});

test('en Windows, un FAIL| de PowerShell se convierte en un error legible', async () => {
  const run: PsRunner = async (_s, env) => (env.NN_KEY_PATH ? 'FAIL|Acceso denegado a la ruta.\r\n' : `USER|${ME}\nFILE|C:\\k`);
  await assert.rejects(protectKeyFile('C:\\k', { platform: 'win32', runPowerShell: run }), /permisos de k: Acceso denegado a la ruta\.\nEjecuta en PowerShell/);
});

test('checkKeyPermissionsMany usa una sola llamada a PowerShell para varias claves', async () => {
  const ps = fakePowerShell({ 'C:\\a': [`ACE|${ME}|Allow|${FULL}|`], 'C:\\b': [`ACE|S-1-1-0|Allow|${READ}|`] });
  const r = await checkKeyPermissionsMany(['C:\\a', 'C:\\b'], { platform: 'win32', runPowerShell: ps.run });
  assert.equal(ps.calls.length, 1);
  assert.equal((r.get('C:\\a') as any).ok, true);
  assert.equal((r.get('C:\\b') as any).ok, false);
});

test('manualFixHint da el comando adecuado a cada sistema', () => {
  assert.match(manualFixHint('/home/a/b c', 'linux'), /chmod 600 '\/home\/a\/b c'/);
  assert.match(manualFixHint('C:\\k', 'win32'), /icacls "C:\\k" \/inheritance:r/);
});

const posix = process.platform !== 'win32';

test('en Linux/macOS detecta modo 0644 y lo deja en 0600', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-perm-'));
  try {
    const f = join(dir, 'k');
    writeFileSync(f, generateKeyPairChecked('ed25519').private);
    chmodSync(f, 0o644);
    const r = await checkKeyPermissions(f);
    assert.equal(r.ok, false);
    assert.match(r.offenders.join(), /grupo.*otros usuarios.*0644/);
    await protectKeyFile(f);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal((await checkKeyPermissions(f)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importKeyFile copia la clave a .ssh protegida y deriva la .pub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-imp-'));
  try {
    const src = join(dir, 'Desktop', 'ssh-key-2026-08-19.key');
    const ssh = join(dir, '.ssh');
    const pair = generateKeyPairChecked('rsa', { bits: 2048, comment: 'oci' });
    require('node:fs').mkdirSync(join(dir, 'Desktop'));
    writeFileSync(src, pair.private);
    if (posix) chmodSync(src, 0o644);
    const r = await importKeyFile(src, ssh);
    assert.equal(r.copied, true);
    assert.equal(r.privatePath, join(ssh, 'ssh-key-2026-08-19.key'));
    assert.equal(readFileSync(r.privatePath, 'utf8'), pair.private);
    assert.equal(readFileSync(r.publicPath!, 'utf8').split(' ').slice(0, 2).join(' '), pair.public.split(' ').slice(0, 2).join(' '));
    assert.equal((await checkKeyPermissions(r.privatePath)).ok, true);
    // Aparece en el gestor de claves con permisos correctos.
    const keys = await listKeys(ssh);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].permsOk, true);
    // Importarla otra vez es inocuo; otra clave con el mismo nombre no se pisa.
    await importKeyFile(src, ssh);
    writeFileSync(src, generateKeyPairChecked('ed25519').private);
    await assert.rejects(importKeyFile(src, ssh), /Ya existe otra clave/);
    // Un archivo que no es una clave se rechaza.
    writeFileSync(join(dir, 'nota.txt'), 'hola');
    await assert.rejects(importKeyFile(join(dir, 'nota.txt'), ssh), /no parece una clave privada/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listKeys marca las claves con permisos demasiado abiertos', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-list-'));
  try {
    const k = await generateKey({ type: 'ed25519', path: join(dir, 'id_ed25519') });
    assert.equal(k.permsOk, true);
    chmodSync(k.privatePath, 0o644);
    const [info] = await listKeys(dir);
    assert.equal(info.permsOk, false);
    assert.match(info.permsIssue!, /0644/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Prueba real en Windows (CI windows-latest): ACL abierta → OpenSSH la rechaza; tras corregirla, la acepta.
const winSshKeygen = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe') : '';

test('Windows real: corrige la ACL y OpenSSH acepta la clave', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nn-win-'));
  try {
    const f = join(dir, 'ssh-key-prueba.key');
    writeFileSync(f, generateKeyPairChecked('ed25519').private);
    // Simula el caso del usuario: cualquiera («Todos», S-1-1-0) puede leerla.
    execFileSync('icacls', [f, '/grant', '*S-1-1-0:(R)']);
    const before = await checkKeyPermissions(f);
    assert.equal(before.ok, false, JSON.stringify(before));
    if (existsSync(winSshKeygen)) {
      const bad = spawnSync(winSshKeygen, ['-y', '-f', f], { encoding: 'utf8' });
      assert.notEqual(bad.status, 0, 'OpenSSH debería rechazar la clave abierta');
    }
    await protectKeyFile(f);
    assert.equal((await checkKeyPermissions(f)).ok, true);
    if (existsSync(winSshKeygen)) {
      const good = spawnSync(winSshKeygen, ['-y', '-f', f], { encoding: 'utf8' });
      assert.equal(good.status, 0, good.stderr);
      assert.match(good.stdout, /^ssh-ed25519 /);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
