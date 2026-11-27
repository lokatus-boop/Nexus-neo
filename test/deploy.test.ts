import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSteps, runDeploy, deviceVars } from '../src/main/netops/deploy';
import { runBackup, normalizeConfig, vendorById, listDeviceBackups } from '../src/main/netops/backup';
import { RunnerDeps } from '../src/main/netops/runner';
import { devicesFromCsv, lineDiff, renderTemplate, templateVars, parseCsv } from '../src/shared/template';
import { startFakeSwitch, FakeSwitch, tempFile } from './helpers/fake-switch';
import type { DeployJob, HostKeyPrompt, NetDevice, SessionConfig } from '../src/shared/types';

let sw1: FakeSwitch;
let sw2: FakeSwitch;
let dir: string;
const sessions: SessionConfig[] = [];

before(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nexus-deploy-'));
  sw1 = await startFakeSwitch('sw1');
  sw2 = await startFakeSwitch('sw2');
  sessions.push({ id: 's-sw1', name: 'sw1', folder: '', kind: 'ssh', host: '127.0.0.1', port: sw1.sshPort, username: 'admin', auth: 'password' });
});

after(async () => {
  await Promise.all([sw1.close(), sw2.close()]);
  await fs.rm(dir, { recursive: true, force: true });
});

function deps(known: Record<string, string> = {}, confirm: (p: HostKeyPrompt) => Promise<boolean> = async () => true): RunnerDeps & { known: Record<string, string> } {
  return {
    known,
    sessionById: (id) => sessions.find((s) => s.id === id),
    secretFor: (id) => (id === 's-sw1' ? { password: 'switchpass' } : undefined),
    knownHosts: { get: (id) => known[id], set: async (id, fp) => void (known[id] = fp) },
    confirmHostKey: confirm,
  };
}

const baseJob = (devices: NetDevice[], commands: string, extra: Partial<DeployJob> = {}): DeployJob => ({
  name: 'prueba',
  devices,
  commands,
  credentials: { username: 'admin', password: 'switchpass' },
  enablePassword: 'cisco',
  concurrency: 4,
  timeoutSec: 10,
  stopOnError: false,
  acceptNewHostKeys: true,
  ...extra,
});

// --- Utilidades ----------------------------------------------------------------

test('parseSteps: órdenes, comentarios y directivas', () => {
  const steps = parseSteps('# comentario\nconfigure terminal\n\n!espera 2\n!intro\n!timeout 600\n!enviar y\n  vlan 10  \n!desconocida x');
  assert.deepEqual(steps, [
    { type: 'cmd', text: 'configure terminal' },
    { type: 'sleep', ms: 2000 },
    { type: 'enter' },
    { type: 'timeout', ms: 600000 },
    { type: 'send', text: 'y' },
    { type: 'cmd', text: 'vlan 10' },
    { type: 'cmd', text: '!desconocida x' },
  ]);
});

test('plantillas: variables, valores por defecto y ausentes', () => {
  assert.deepEqual(templateVars('a {{x}} {{ y | 3 }} {{x}}'), ['x', 'y']);
  assert.deepEqual(renderTemplate('ip {{ip}} vlan {{vlan | 10}} gw {{gw}}', { IP: '1.2.3.4' }), { text: 'ip 1.2.3.4 vlan 10 gw {{gw}}', missing: ['gw'] });
  const v = deviceVars({ id: 'a', name: 'sw', host: 'h', protocol: 'ssh', username: 'u', vars: { vlan: '20' } }, { vars: { vlan: '1', site: 'MAD' }, upload: { localPath: '/x/fw.bin', remotePath: 'flash:', method: 'scp' } });
  assert.equal(v.vlan, '20');
  assert.equal(v.site, 'MAD');
  assert.equal(v.file, 'fw.bin');
  assert.equal(v.host, 'h');
  assert.match(v.tftp, /^\d+\.\d+\.\d+\.\d+$/);
});

test('CSV de equipos: separadores, comillas, columnas reconocidas y variables', () => {
  const { headers, rows } = parseCsv('nombre;ip;"descripción"\nsw-1;10.0.0.1;"Planta 1; norte"\n');
  assert.deepEqual(headers, ['nombre', 'ip', 'descripción']);
  assert.equal(rows[0]['descripción'], 'Planta 1; norte');
  const devs = devicesFromCsv('name,host,protocol,port,vendor,vlan\nsw-a,10.0.0.1,telnet,2323,cisco-ios,20\n,10.0.0.2,,,,30\nsin-host,,,,,\n');
  assert.equal(devs.length, 2);
  assert.deepEqual(devs[0], { id: 'csv-1', name: 'sw-a', host: '10.0.0.1', protocol: 'telnet', port: 2323, vendor: 'cisco-ios', vars: { vlan: '20' } });
  assert.equal(devs[1].name, '10.0.0.2');
  assert.equal(devs[1].protocol, 'ssh');
  assert.throws(() => devicesFromCsv('nombre,vlan\nx,1'), /host/);
  assert.deepEqual(devicesFromCsv(''), []);
  // «ip» es sinónimo de host sólo si no hay columna host; si la hay, es una variable más.
  assert.deepEqual(devicesFromCsv('name,host,ip\nsw,10.0.0.1,10.9.9.9')[0].vars, { ip: '10.9.9.9' });
  assert.equal(devicesFromCsv('nombre,ip\nsw,10.0.0.1')[0].host, '10.0.0.1');
});

test('diferencias línea a línea', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.filter((l) => l.op !== ' '), [{ op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: '+', text: 'e' }]);
  assert.equal(lineDiff('x\ny', 'x\ny').every((l) => l.op === ' '), true);
});

// --- Despliegue contra switches simulados -----------------------------------------

test('despliegue por SSH a varios equipos con enable, variables, paginador y preguntas', async () => {
  const devices: NetDevice[] = [
    { id: 'a', name: 'sw1', host: '127.0.0.1', protocol: 'ssh', sessionId: 's-sw1', vars: { vlan: '10' } },
    { id: 'b', name: 'sw2', host: '127.0.0.1', port: sw2.sshPort, protocol: 'ssh', vars: { vlan: '20' } },
  ];
  sw1.state.flash.set('viejo.bin', Buffer.from('x'));
  const d = deps();
  const updates: number[] = [];
  const { done } = runDeploy(baseJob(devices, 'configure terminal\ninterface Vlan{{vlan}}\n description Gestion {{name}}\nend\nshow running-config\ndelete flash:viejo.bin\n!intro\n!intro\nwrite memory'), d, dir, (p) => updates.push(p.results.length));
  const res = await done;
  for (const r of res.results) assert.equal(r.status, 'ok', `${r.name}: ${r.message}\n${r.output}`);
  assert.ok(sw1.state.config.includes('interface Vlan10'));
  assert.ok(sw1.state.config.includes(' description Gestion sw1'));
  assert.ok(sw2.state.config.includes('interface Vlan20'));
  assert.equal(sw1.state.flash.has('viejo.bin'), false, 'la pregunta de borrado se respondió');
  // El paginador se saltó: la salida contiene la configuración entera.
  assert.match(res.results[0].output, /GigabitEthernet0\/30/);
  assert.doesNotMatch(res.results[0].output, /--More--/);
  // Huellas nuevas aceptadas y guardadas.
  assert.equal(Object.keys(d.known).length, 2);
  // Archivos de resultado.
  const csv = await fs.readFile(join(res.dir, 'resumen.csv'), 'utf8');
  assert.match(csv, /"sw1";"127\.0\.0\.1";ok/);
  const log = await fs.readFile(join(res.dir, 'sw2.log'), 'utf8');
  assert.match(log, /> interface Vlan20/);
  const json = JSON.parse(await fs.readFile(join(res.dir, 'resumen.json'), 'utf8'));
  assert.equal(json.results.length, 2);
  assert.equal(json.results[0].output, undefined);
  assert.ok(updates.length > 2);
});

test('despliegue: detecta órdenes con error y para si se pide', async () => {
  const dev: NetDevice[] = [{ id: 'b', name: 'sw2', host: '127.0.0.1', port: sw2.sshPort, protocol: 'ssh' }];
  const cmds = 'configure terminal\nbogus command\nhostname sw2\nend\nshow nada';
  let r = (await runDeploy(baseJob(dev, cmds), deps(), dir, () => undefined).done).results[0];
  assert.equal(r.status, 'error');
  assert.equal(r.message, '2 orden(es) con error');
  r = (await runDeploy(baseJob(dev, cmds, { stopOnError: true }), deps(), dir, () => undefined).done).results[0];
  assert.equal(r.status, 'error');
  assert.match(r.message!, /bogus command.*Invalid input/);
  assert.doesNotMatch(r.output, /> show nada/);
});

test('despliegue por Telnet con usuario, contraseña y enable', async () => {
  const dev: NetDevice[] = [{ id: 't', name: 'sw2-telnet', host: '127.0.0.1', port: sw2.telnetPort, protocol: 'telnet' }];
  const res = await runDeploy(baseJob(dev, 'configure terminal\nsnmp-server community {{comunidad | publica}} RO\nend\nshow version'), deps(), dir, () => undefined).done;
  const r = res.results[0];
  assert.equal(r.status, 'ok', r.output);
  assert.match(r.output, /Version 15\.2/);
  assert.ok(sw2.state.config.includes('snmp-server community publica RO'));
  // Contraseña incorrecta.
  const bad = await runDeploy(baseJob(dev, 'show version', { credentials: { username: 'admin', password: 'mala' } }), deps(), dir, () => undefined).done;
  assert.equal(bad.results[0].status, 'error');
  assert.match(bad.results[0].message!, /Usuario o contraseña incorrectos/);
});

test('despliegue: sube un archivo por SCP y usa {{file}}', async () => {
  const fw = await tempFile(dir, 'c2960-firmware.bin', Buffer.alloc(200_000, 7));
  const dev: NetDevice[] = [{ id: 'a', name: 'sw1', host: '127.0.0.1', protocol: 'ssh', sessionId: 's-sw1' }];
  const res = await runDeploy(baseJob(dev, 'show flash:', { upload: { localPath: fw, remotePath: 'flash:', method: 'scp' } }), deps(), dir, () => undefined).done;
  const r = res.results[0];
  assert.equal(r.status, 'ok', r.output);
  assert.equal(sw1.state.flash.get('c2960-firmware.bin')?.length, 200_000);
  assert.match(r.output, /100%/);
  assert.match(r.output, /200000 {2}c2960-firmware\.bin/);
});

test('despliegue: tiempo de espera, equipo inaccesible y cancelación', async () => {
  const dev: NetDevice[] = [
    { id: 'a', name: 'lento', host: '127.0.0.1', port: sw2.sshPort, protocol: 'ssh' },
    { id: 'b', name: 'apagado', host: '127.0.0.1', port: 1, protocol: 'ssh' },
  ];
  const res = await runDeploy(baseJob(dev, '!timeout 1\nslow'), deps(), dir, () => undefined).done;
  assert.match(res.results[0].message!, /Tiempo de espera agotado/);
  assert.equal(res.results[1].status, 'error');
  const many: NetDevice[] = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, name: `c${i}`, host: '127.0.0.1', port: sw2.sshPort, protocol: 'ssh' as const }));
  const { runner, done } = runDeploy(baseJob(many, '!espera 1', { concurrency: 1 }), deps(), dir, () => undefined);
  setTimeout(() => runner.cancel(), 300);
  const c = await done;
  assert.equal(c.results[0].status, 'ok');
  assert.deepEqual(c.results.slice(1).map((r) => r.status), ['cancelled', 'cancelled', 'cancelled']);
});

test('despliegue: huellas SSH nuevas y cambiadas', async () => {
  const sw = await startFakeSwitch('sw-huella');
  try {
    const dev: NetDevice[] = [{ id: 'h', name: 'sw-huella', host: '127.0.0.1', port: sw.sshPort, protocol: 'ssh' }];
    const asked: HostKeyPrompt[] = [];
    const known: Record<string, string> = {};
    const confirm = async (p: HostKeyPrompt) => (asked.push(p), false);
    // Sin aceptación automática se pregunta (y aquí se rechaza).
    let r = (await runDeploy(baseJob(dev, 'show version', { acceptNewHostKeys: false }), deps(known, confirm), dir, () => undefined).done).results[0];
    assert.equal(r.status, 'error');
    assert.equal(asked.length, 1);
    // Con aceptación automática no se pregunta y se guarda.
    r = (await runDeploy(baseJob(dev, 'show version'), deps(known, confirm), dir, () => undefined).done).results[0];
    assert.equal(r.status, 'ok', r.output);
    assert.equal(asked.length, 1);
    assert.match(r.output, /Huella nueva aceptada/);
    // Si la huella cambia, se pregunta siempre aunque esté activada la aceptación automática.
    sw.rotateHostKey();
    await new Promise((res) => setTimeout(res, 100));
    r = (await runDeploy(baseJob(dev, 'show version'), deps(known, confirm), dir, () => undefined).done).results[0];
    assert.equal(r.status, 'error');
    assert.equal(asked.length, 2);
    assert.ok(asked[1].previous);
    assert.match(r.output, /ha cambiado/);
  } finally {
    await sw.close();
  }
});

// --- Respaldos ----------------------------------------------------------------------

test('normalizeConfig ignora las líneas volátiles del fabricante', () => {
  const v = vendorById('cisco-ios');
  const a = 'Building configuration...\nCurrent configuration : 100 bytes\n! Last configuration change at 10:00\nhostname x\n';
  const b = 'Building configuration...\nCurrent configuration : 120 bytes\n! Last configuration change at 11:00\nhostname x  \n';
  assert.equal(normalizeConfig(a, v), normalizeConfig(b, v));
  assert.notEqual(normalizeConfig(a, v), normalizeConfig(a.replace('hostname x', 'hostname y'), v));
  assert.equal(vendorById('no-existe').id, 'cisco-ios');
});

test('respaldo: primera copia, sin cambios y cambio detectado', async () => {
  const bdir = join(dir, 'backups');
  const dev: NetDevice[] = [
    { id: 'a', name: 'sw1', host: '127.0.0.1', protocol: 'ssh', sessionId: 's-sw1', vendor: 'cisco-ios' },
    { id: 't', name: 'sw2', host: '127.0.0.1', port: sw2.telnetPort, protocol: 'telnet', vendor: 'cisco-ios' },
  ];
  const job = { name: 'respaldo', devices: dev, credentials: { username: 'admin', password: 'switchpass' }, enablePassword: 'cisco', concurrency: 2, timeoutSec: 10, acceptNewHostKeys: true };
  let res = await runBackup(job, deps(), bdir, () => undefined).done;
  for (const r of res.results) {
    assert.equal(r.status, 'ok', r.output);
    assert.equal(r.changed, true);
    assert.equal(r.message, 'Primer respaldo');
  }
  const saved = await fs.readFile(res.results[0].backupFile!, 'utf8');
  assert.match(saved, /^Building configuration/);
  assert.match(saved, /hostname sw1\n/);
  assert.doesNotMatch(saved, /sw1#/);
  assert.ok(sw1.state.history.includes('terminal length 0'));
  // Segundo respaldo: sólo cambia la fecha de «Last configuration change»: sin cambios.
  await new Promise((r) => setTimeout(r, 1100));
  res = await runBackup(job, deps(), bdir, () => undefined).done;
  assert.deepEqual(res.results.map((r) => [r.status, r.changed, r.message]), [['ok', false, 'Sin cambios'], ['ok', false, 'Sin cambios']]);
  // Cambio real en sw1.
  sw1.state.config.splice(5, 0, 'ip domain-name ejemplo.local');
  res = await runBackup(job, deps(), bdir, () => undefined).done;
  assert.equal(res.results[0].changed, true);
  assert.equal(res.results[0].message, 'Cambiada');
  assert.equal(res.results[1].changed, false);
  const list = await listDeviceBackups(bdir, 'sw1');
  assert.equal(list.length, 2);
  assert.ok(list[0].time >= list[1].time);
  const diff = lineDiff(await fs.readFile(list[1].file, 'utf8'), await fs.readFile(list[0].file, 'utf8')).filter((l) => l.op === '+');
  assert.ok(diff.some((l) => l.text === 'ip domain-name ejemplo.local'));
  // Perfil equivocado: el equipo no reconoce la orden.
  const wrong = await runBackup({ ...job, devices: [{ ...dev[0], vendor: 'huawei' }] }, deps(), bdir, () => undefined).done;
  assert.equal(wrong.results[0].status, 'error');
  assert.match(wrong.results[0].message!, /no reconoce «display current-configuration»/);
});
