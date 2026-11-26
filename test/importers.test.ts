import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig, buildNexusExport, parseNexusExport } from '../src/main/importers';
import { parseQuickConnect } from '../src/renderer/quick-connect';
import { buildExternalCommand } from '../src/main/protocols/external';
import { DEFAULT_SETTINGS } from '../src/main/store';

const CONFIG = `
Host *
  ServerAliveInterval 30

Host bastion
  HostName 203.0.113.10
  User admin
  Port 2222

Host web # servidor web
  HostName 10.0.0.5
  User deploy
  IdentityFile ~/.ssh/id_web
  ProxyJump bastion
  ForwardX11 yes
  LocalForward 8080 localhost:80
  DynamicForward 1080
`;

test('importa ~/.ssh/config con saltos y túneles', () => {
  const s = parseSshConfig(CONFIG);
  assert.equal(s.length, 2);
  const bastion = s.find((x) => x.name === 'bastion')!;
  const web = s.find((x) => x.name === 'web')!;
  assert.equal(bastion.host, '203.0.113.10');
  assert.equal(bastion.port, 2222);
  assert.equal(web.auth, 'key');
  assert.equal(web.keyPath, '~/.ssh/id_web');
  assert.equal(web.jumpSessionId, bastion.id);
  assert.equal(web.x11, true);
  assert.deepEqual(web.tunnels!.map((t) => [t.type, t.bindPort, t.destHost, t.destPort]), [
    ['local', 8080, 'localhost', 80],
    ['dynamic', 1080, '', 0],
  ]);
});

test('exportación propia: ida y vuelta con nuevos ids', () => {
  const s = parseSshConfig(CONFIG);
  const back = parseNexusExport(buildNexusExport(s));
  assert.equal(back.length, 2);
  assert.notEqual(back[0].id, s[0].id);
  const web = back.find((x) => x.name === 'web')!;
  assert.equal(web.jumpSessionId, back.find((x) => x.name === 'bastion')!.id);
  assert.throws(() => parseNexusExport('{"foo":1}'));
});

test('conexión rápida', () => {
  assert.deepEqual(
    (({ kind, username, host, port }) => ({ kind, username, host, port }))(parseQuickConnect('root@10.0.0.1:2200')!),
    { kind: 'ssh', username: 'root', host: '10.0.0.1', port: 2200 },
  );
  assert.equal(parseQuickConnect('telnet://router')!.port, 23);
  assert.equal(parseQuickConnect('rdp://win10')!.kind, 'rdp');
  assert.equal(parseQuickConnect('[::1]:22')!.host, '::1');
  assert.equal(parseQuickConnect(''), null);
});

test('comando de cliente RDP/VNC externo', () => {
  const rdp = { id: '1', name: 'w', folder: '', kind: 'rdp' as const, host: 'win', port: 3389, username: 'ana' };
  assert.deepEqual(buildExternalCommand(rdp, DEFAULT_SETTINGS, 'win32'), { command: 'mstsc.exe', args: ['/v:win:3389'] });
  const lin = buildExternalCommand(rdp, DEFAULT_SETTINGS, 'linux');
  assert.equal(lin.command, 'xfreerdp');
  assert.ok(lin.args.includes('/u:ana'));
  assert.deepEqual(buildExternalCommand({ ...rdp, kind: 'vnc', port: 5901 }, DEFAULT_SETTINGS, 'linux'), { command: 'vncviewer', args: ['win::5901'] });
});
