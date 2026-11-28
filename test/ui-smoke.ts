// Prueba de humo de la interfaz: arranca la app real de Electron con Playwright
// y recorre los flujos principales contra un servidor SSH de pruebas.
import { _electron as electron, Page } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startTestServer } from './helpers/ssh-server';
import { startFakeSwitch } from './helpers/fake-switch';
import { startFakeVnc } from './helpers/rfb-server';

const shots = process.env.SHOTS_DIR || join(tmpdir(), 'nexus-shots');
mkdirSync(shots, { recursive: true });

async function termText(page: Page): Promise<string> {
  return page.locator('.pane:not(.hidden) .xterm-rows').innerText();
}

async function waitTerm(page: Page, text: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await termText(page)).includes(text)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`No apareció "${text}" en el terminal. Contenido: ${await termText(page)}`);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-ui-sftp-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'notas.txt'), 'hola');
  writeFileSync(join(root, 'config.yaml'), 'a: 1');
  const srv = await startTestServer(root);
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-ui-data-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'nexus-ui-home-'));

  // Plugin de ejemplo ya copiado en la carpeta de plugins (sin activar).
  cpSync(join(process.cwd(), 'examples/plugins/marcas-de-tiempo'), join(dataDir, 'plugins', 'marcas-de-tiempo'), { recursive: true });
  // Plugin «sonda» ya activado: comprueba que el worker no tiene red, Node ni DOM.
  mkdirSync(join(dataDir, 'plugins', 'sonda'), { recursive: true });
  writeFileSync(join(dataDir, 'plugins', 'sonda', 'manifest.json'), JSON.stringify({ id: 'sonda', name: 'Sonda', version: '1.0.0' }));
  writeFileSync(join(dataDir, 'plugins', 'sonda', 'main.js'), `
    const t = (f) => { try { return f(); } catch { return 'bloqueado'; } };
    const r = { fetch: typeof fetch, xhr: typeof XMLHttpRequest, ws: typeof WebSocket, imp: typeof importScripts, req: typeof require, proc: typeof process, doc: typeof document,
      proto: typeof Object.getPrototypeOf(self).fetch, fn: t(() => typeof new Function('return fetch')()) };
    const vis = Object.keys(r).filter((k) => r[k] !== 'undefined' && r[k] !== 'bloqueado');
    nexus.ui.setStatus('sonda:' + (vis.length ? vis.join(',') : 'aislado'));
    nexus.terminal.send('no-debe-llegar').catch((e) => nexus.storage.set('error', e.message));
  `);
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ plugins: { sonda: { permissions: [] } } }));

  const { createRequire } = await import('node:module');
  const executablePath = createRequire(join(process.cwd(), 'package.json'))('electron') as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: ['.', '--no-sandbox'],
    // HOME aislado para no tocar ~/.ssh del usuario al probar el generador de claves.
    env: { ...process.env, NEXUS_NEO_DATA_DIR: dataDir, ...(process.env.RFB_DEBUG ? { NEXUS_NEO_VNC_DEBUG: '1' } : {}), SHELL: '/bin/bash', HOME: fakeHome, USERPROFILE: fakeHome },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 860 });
  // Primer arranque: aviso legal con aceptación obligatoria.
  await page.waitForSelector('.modal .first-run');
  const acceptBtn = page.locator('.modal button:has-text("Aceptar y continuar")');
  if (!(await acceptBtn.isDisabled())) throw new Error('El aviso se puede aceptar sin marcar la casilla');
  await page.screenshot({ path: join(shots, '10-aviso-legal.png') });
  await page.check('.modal .first-run input[type=checkbox]');
  await acceptBtn.click();
  await page.waitForSelector('.modal', { state: 'detached' });
  if (!JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).disclaimerAccepted) throw new Error('No se guardó la aceptación del aviso');
  console.log('✔ aviso legal en el primer arranque');

  await page.waitForSelector('#welcome .card-btn');
  await page.waitForSelector('#status-plugins:has-text("sonda:")');
  assert.equal(await page.locator('#status-plugins').innerText(), 'sonda:aislado');
  for (let i = 0; i < 50 && !existsSync(join(dataDir, 'plugin-data', 'sonda.json')); i++) await page.waitForTimeout(100);
  assert.match(JSON.parse(readFileSync(join(dataDir, 'plugin-data', 'sonda.json'), 'utf8')).error, /permiso «terminal:write»/);
  console.log('✔ plugins aislados (sin red, Node ni DOM; permisos comprobados)');
  await page.screenshot({ path: join(shots, '01-bienvenida.png') });
  console.log('✔ pantalla de bienvenida');

  await page.click('#btn-about');
  await page.waitForSelector('.modal .about-author:has-text("Luismi Sanz")');
  await page.screenshot({ path: join(shots, '11-acerca-de.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  console.log('✔ acerca de');

  // Terminal local
  await page.keyboard.press('Control+Shift+T');
  await page.waitForSelector('.tab[data-state="connected"]');
  await page.locator('.pane:not(.hidden) .xterm').click();
  await page.keyboard.type('echo NEXUS_$((40+2))\n');
  await waitTerm(page, 'NEXUS_42');
  console.log('✔ terminal local');

  // Crear bóveda
  await page.click('#btn-vault');
  const pw = page.locator('.modal input[type=password]');
  await pw.nth(0).fill('maestra-segura');
  await pw.nth(1).fill('maestra-segura');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('#btn-vault.active');
  console.log('✔ bóveda creada');

  // Nueva sesión SSH con contraseña guardada
  await page.click('#btn-new');
  const form = page.locator('.modal .session-form');
  await form.locator('.field:has-text("Nombre") input').first().fill('Servidor de pruebas');
  await form.locator('.field:has-text("Carpeta") input').fill('Laboratorio');
  await form.locator('.field:has-text("Host") input').fill('127.0.0.1');
  await form.locator('.field:has-text("Puerto") input').first().fill(String(srv.port));
  await form.locator('.field:has-text("Usuario") input').fill('nexus');
  await form.locator('.field:has-text("Contraseña") input[type=password]').first().fill('secreto');
  await page.screenshot({ path: join(shots, '02-editor-sesion.png') });
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.tree-item:has-text("Servidor de pruebas")');
  console.log('✔ sesión guardada');

  // Conectar: verificación de huella y shell
  await page.dblclick('.tree-item:has-text("Servidor de pruebas")');
  await page.waitForSelector('.modal:has-text("Verificar host")');
  await page.click('.modal .btn.primary');
  await waitTerm(page, 'Bienvenido');
  await page.waitForSelector('.sftp-row:has-text("docs")');
  await page.locator('.pane:not(.hidden) .xterm').click();
  await page.keyboard.type('uptime');
  await waitTerm(page, 'eco:u');
  await page.waitForFunction(() => document.querySelector('.pane:not(.hidden) .pane-monitor')?.textContent?.includes('CPU'));
  await page.screenshot({ path: join(shots, '03-ssh-sftp.png') });
  console.log('✔ SSH + SFTP + monitor');

  // Editor SFTP integrado
  await page.dblclick('.sftp-row:has-text("config.yaml")');
  await page.waitForSelector('.modal textarea.editor');
  await page.locator('.modal textarea.editor').fill('a: 2\n');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(readFileSync(join(root, 'config.yaml'), 'utf8'), 'a: 2\n');
  console.log('✔ editor remoto');

  // Multi-ejecución
  await page.keyboard.press('Control+Shift+M');
  await page.waitForSelector('body.multiexec');
  await page.screenshot({ path: join(shots, '04-multiejecucion.png') });
  await page.keyboard.press('Control+Shift+M');
  console.log('✔ multi-ejecución');

  // Macro
  await page.click('#btn-macros');
  await page.click('.modal .btn:has-text("Nueva macro")');
  const mm = page.locator('.modal').last();
  await mm.locator('input').fill('Saludo');
  await mm.locator('textarea').fill('saludo-macro');
  await mm.locator('.btn.primary').click();
  await page.waitForSelector('.macro-row:has-text("Saludo")');
  await page.click('.macro-row .btn:has-text("Ejecutar")');
  await page.click('.modal .btn.primary:has-text("Cerrar")');
  await waitTerm(page, 'eco:saludo-macro');
  console.log('✔ macros');

  // Sincronización cifrada a una carpeta
  const syncDir = mkdtempSync(join(tmpdir(), 'nexus-ui-sync-'));
  await page.click('#btn-sync');
  const sm = page.locator('.modal').last();
  await sm.locator('label.check:has-text("Activar") input').check();
  await sm.locator('.field:has-text("Carpeta") input').fill(syncDir);
  await sm.locator('.field:has-text("Frase de sincronización") input').fill('frase-de-prueba');
  await sm.locator('.field:has-text("Repítela") input').fill('frase-de-prueba');
  await sm.locator('.btn:has-text("Sincronizar ahora")').click();
  await page.waitForSelector('#sync-status:has-text("Sincronizado")');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '13-sincronizacion.png') });
  await sm.locator('.btn.primary:has-text("Guardar")').click();
  await page.waitForSelector('#btn-sync.active');
  assert.ok(existsSync(join(syncDir, 'nexus-neo-sync.json')));
  assert.ok(!readFileSync(join(syncDir, 'nexus-neo-sync.json'), 'utf8').includes('Servidor de pruebas'), 'el archivo de sincronización debe ir cifrado');
  console.log('✔ sincronización cifrada');

  // Operaciones de red contra un switch simulado: despliegue, plantilla y respaldo
  const fsw = await startFakeSwitch('sw-ui');
  const devCsv = `name,host,port,vendor,vlan\nsw-ui,127.0.0.1,${fsw.sshPort},cisco-ios,30`;
  const fillConn = async (pane: string) => {
    const p = page.locator(`#np-pane-${pane}`);
    const d = p.locator('details.np-adv:has(summary:has-text("Credenciales"))');
    await d.locator('summary').click();
    await d.locator('.field:has-text("Usuario") input').fill('admin');
    await d.locator('.field:has(> .field-label:text-is("Contraseña")) input').fill('switchpass');
    await d.locator('.field:has-text("Contraseña de enable") input').fill('cisco');
    await d.locator('label.check:has-text("Aceptar automáticamente") input').check();
    await p.locator('.field:has-text("Más equipos (CSV)") textarea').fill(devCsv);
  };
  await page.click('#btn-netops');
  await page.waitForSelector('#np-pane-deploy');
  await fillConn('deploy');
  await page.locator('#np-pane-deploy .field:has(> .field-label:text-is("Órdenes")) textarea').fill('configure terminal\nvlan {{vlan}}\n name usuarios\nend\nshow version');
  await page.click('#np-run-deploy');
  await page.waitForSelector('#np-pane-deploy #np-summary:has-text("Terminado: 1 correctos")', { timeout: 30000 });
  await page.click('#np-pane-deploy tr[data-device="sw-ui"]');
  await page.waitForSelector('#np-pane-deploy .np-output:has-text("Version 15.2")');
  assert.ok(fsw.state.config.includes('vlan 30'), 'el despliegue debe aplicar la orden con la variable del CSV');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '14-despliegue.png') });
  console.log('✔ despliegue masivo');

  await page.click('.np-tab:has-text("Plantillas")');
  const tp = page.locator('#np-pane-templates');
  await tp.locator('.field:has-text("Nombre") input').first().fill('Gestión acceso');
  await tp.locator('.field:has(> .field-label:text-is("Plantilla")) textarea').fill('hostname {{name}}\ninterface Vlan{{vlan | 10}}\n ip address {{ip}} 255.255.255.0');
  await tp.locator('.field:has-text("Valores por equipo") textarea').fill('name,host,ip\nsw-a,10.0.0.1,10.0.10.1\nsw-b,10.0.0.2,');
  await page.waitForSelector('#np-tpl-preview:has-text("ip address 10.0.10.1")');
  await tp.locator('.field:has-text("Vista previa de") select').selectOption({ label: 'sw-b' });
  await page.waitForSelector('#np-tpl-preview:has-text("Faltan: ip")');
  await page.click('#np-tpl-save');
  await page.waitForSelector('#np-pane-templates .np-tpl.active:has-text("Gestión acceso")');
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'templates.json'), 'utf8')).some((t: { name: string }) => t.name === 'Gestión acceso'));
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '15-plantillas.png') });
  console.log('✔ plantillas de configuración');

  await page.click('.np-tab:has-text("Respaldos")');
  await fillConn('backups');
  await page.click('#np-run-backup');
  await page.waitForSelector('#np-pane-backups #np-summary:has-text("Terminado: 1 correctos")', { timeout: 30000 });
  await page.waitForSelector('#np-pane-backups .np-dev-backups .np-tpl:has-text("sw-ui")');
  fsw.state.config.splice(4, 0, 'ip domain-name ui.local');
  await page.click('#np-run-backup');
  await page.waitForFunction(() => document.querySelector('#np-pane-backups #np-summary')?.textContent?.startsWith('Terminado') && document.querySelector('#np-pane-backups .np-dev-backups .np-tpl small')?.textContent?.startsWith('2 '), null, { timeout: 30000 });
  await page.click('#np-pane-backups .np-dev-backups .np-tpl:has-text("sw-ui")');
  await page.click('#np-compare');
  await page.waitForSelector('.np-diff .np-add:has-text("ip domain-name ui.local")');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.locator('.np-diff').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, '16-respaldos.png') });
  await page.click('.modal .modal-footer .btn:has-text("Cerrar")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await fsw.close();
  console.log('✔ respaldos de configuración');

  // Paleta
  await page.locator('.pane:not(.hidden) .xterm').click();
  await page.keyboard.press('Control+Shift+K');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('pruebas');
  await page.screenshot({ path: join(shots, '05-paleta.png') });
  await page.keyboard.press('Escape');
  console.log('✔ paleta de comandos');

  // Servidores integrados: TFTP con curl y Syslog
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('#servers-panel:not(.hidden) .srv-card');
  const tftpCard = page.locator('.srv-card:has(strong:text-is("TFTP"))');
  await tftpCard.locator('.icon-btn[title="Configurar"]').click();
  await tftpCard.locator('.srv-row:has-text("Carpeta raíz") input').fill(root);
  await tftpCard.locator('.srv-row:has-text("Puerto") input').fill('16969');
  await tftpCard.locator('.btn:has-text("Guardar")').click();
  await page.waitForSelector('.srv-card:has(strong:text-is("TFTP")) .srv-form', { state: 'detached' });
  await tftpCard.locator('.btn:has-text("Iniciar")').click();
  await page.waitForSelector('.srv-card.running:has(strong:text-is("TFTP"))');
  const { execFile } = await import('node:child_process');
  const dl = join(tmpdir(), `nexus-ui-tftp-${Date.now()}.txt`);
  await new Promise<void>((res, rej) => execFile('curl', ['-sS', '-o', dl, 'tftp://127.0.0.1:16969/docs/notas.txt'], (e) => (e ? rej(e) : res())));
  assert.equal(readFileSync(dl, 'utf8'), 'hola');
  await page.waitForSelector('.log-line.lvl-transfer:has-text("completada")');
  const sysCard = page.locator('.srv-card:has(strong:text-is("Syslog"))');
  await sysCard.locator('.icon-btn[title="Configurar"]').click();
  await sysCard.locator('.srv-row:has-text("Carpeta de logs") input').fill(join(root, 'logs'));
  await sysCard.locator('.srv-row:has-text("Puerto") input').fill('15514');
  await sysCard.locator('.btn:has-text("Guardar")').click();
  await sysCard.locator('.btn:has-text("Iniciar")').click();
  await page.waitForSelector('.srv-card.running:has(strong:text-is("Syslog"))');
  const { createSocket } = await import('node:dgram');
  const u = createSocket('udp4');
  for (const m of ['<187>sw-core-01: %LINK-3-UPDOWN: Interface Gi1/0/24, changed state to down', '<189>sw-core-01: %SYS-5-CONFIG_I: Configured from console by admin', '<190>ap-planta2: firmware 8.10.2 descargado por TFTP']) {
    await new Promise<void>((r) => u.send(m, 15514, '127.0.0.1', () => r()));
  }
  u.close();
  await page.waitForSelector('.log-line:has-text("changed state to down")');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '07-servidores.png') });
  await tftpCard.locator('.btn:has-text("Detener")').click();
  await sysCard.locator('.btn:has-text("Detener")').click();
  await page.waitForSelector('.srv-card.running', { state: 'detached' });
  console.log('✔ servidores TFTP y Syslog');

  // SFTP/SCP y HTTPS configurados desde el panel, comprobados con curl.
  const curlOut = (args: string[]) => new Promise<string>((res, rej) => execFile('curl', ['-sS', '--max-time', '20', ...args], (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
  const sftpCard = page.locator('.srv-card:has(strong:text-is("SFTP / SCP"))');
  await sftpCard.locator('.icon-btn[title="Configurar"]').click();
  await sftpCard.locator('.srv-row:has-text("Carpeta raíz") input').fill(root);
  await sftpCard.locator('.srv-row:has-text("Puerto") input').fill('12222');
  await sftpCard.locator('.srv-row:has-text("Contraseña") input').fill('clave-ui');
  await sftpCard.locator('.btn:has-text("Guardar")').click();
  await page.waitForSelector('.srv-card:has(strong:text-is("SFTP / SCP")) .srv-form', { state: 'detached' });
  await sftpCard.locator('.btn:has-text("Iniciar")').click();
  await page.waitForSelector('.srv-card.running:has(strong:text-is("SFTP / SCP"))');
  if (/\bsftp\b/.test(execFileSync('curl', ['-V'], { encoding: 'utf8' }))) {
    assert.equal(await curlOut(['-k', '-u', 'nexus:clave-ui', 'sftp://127.0.0.1:12222/docs/notas.txt']), 'hola');
    await page.waitForSelector('.log-line.lvl-transfer:has-text("por SFTP")');
  }
  const httpsCard = page.locator('.srv-card:has(strong:text-is("HTTPS"))');
  await httpsCard.locator('.icon-btn[title="Configurar"]').click();
  await httpsCard.locator('.srv-row:has-text("Carpeta raíz") input').fill(root);
  await httpsCard.locator('.srv-row:has-text("Puerto") input').fill('18443');
  await httpsCard.locator('.btn:has-text("Guardar")').click();
  await page.waitForSelector('.srv-card:has(strong:text-is("HTTPS")) .srv-form', { state: 'detached' });
  await httpsCard.locator('.btn:has-text("Iniciar")').click();
  await page.waitForSelector('.srv-card.running:has(strong:text-is("HTTPS"))');
  assert.equal(await curlOut(['-k', 'https://127.0.0.1:18443/docs/notas.txt']), 'hola');
  await page.waitForSelector('.log-line:has-text("certificado autofirmado")');
  // DHCP: sólo el formulario (arrancarlo repartiría IP en la red del equipo de pruebas).
  const dhcpCard = page.locator('.srv-card:has(strong:text-is("DHCP"))');
  await dhcpCard.locator('.icon-btn[title="Configurar"]').click();
  await dhcpCard.locator('.srv-row:has-text("Puerta de enlace") input').fill('192.168.50.1');
  await dhcpCard.locator('.srv-row:has-text("Servidor TFTP") input').fill('192.168.50.1');
  await dhcpCard.locator('.srv-row:has-text("Reservas") textarea').fill('00:1b:54:aa:bb:01 192.168.50.20 telefono-recepcion');
  await dhcpCard.locator('.btn:has-text("Guardar")').click();
  await page.waitForSelector('.srv-card:has(strong:text-is("DHCP")) .srv-form', { state: 'detached' });
  await dhcpCard.locator('.icon-btn[title="Configurar"]').click();
  assert.match(await dhcpCard.locator('.srv-row:has-text("Reservas") textarea').inputValue(), /telefono-recepcion/);
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.evaluate(() => document.querySelector('.srv-card:has(.srv-form)')?.scrollIntoView());
  await page.screenshot({ path: join(shots, '20-servidores-sftp-https-dhcp.png') });
  await dhcpCard.locator('.icon-btn[title="Configurar"]').click();
  await sftpCard.locator('.btn:has-text("Detener")').click();
  await httpsCard.locator('.btn:has-text("Detener")').click();
  await page.waitForSelector('.srv-card.running', { state: 'detached' });
  await page.keyboard.press('Control+Shift+E');
  console.log('✔ servidores SFTP/SCP, HTTPS y formulario DHCP');

  // Vista dividida: dos pestañas lado a lado
  await page.keyboard.press('Control+Shift+T');
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-state="connected"]').length >= 3);
  await page.click('#btn-layout');
  await page.click('.ctx-item:has-text("Cuadrícula de 4")');
  await page.waitForFunction(() => document.querySelectorAll('#panes.layout-grid4 > .pane:not(.hidden)').length === 3);
  await page.locator('.pane.focused .xterm').click();
  await page.keyboard.type('echo DIVIDIDA_$((6*7))\n');
  await page.waitForFunction(() => document.querySelector('.pane.focused .xterm-rows')?.textContent?.includes('DIVIDIDA_42'));
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '08-vista-dividida.png') });
  await page.click('#btn-layout');
  await page.click('.ctx-item:has-text("Una pestaña")');
  await page.waitForFunction(() => document.querySelectorAll('#panes > .pane:not(.hidden)').length === 1);
  console.log('✔ vista dividida');

  // Generador de claves SSH e instalación en el servidor de la pestaña SSH
  await page.click('.tab:has-text("Servidor de pruebas")');
  await page.click('#btn-keys');
  await page.click('.modal .btn:has-text("Generar nueva")');
  const gen = page.locator('.modal').last();
  await gen.locator('.field:has-text("Nombre del archivo") input').fill('nexus_prueba_ui');
  await gen.locator('.btn.primary:has-text("Generar")').click();
  await page.waitForSelector('.modal:has-text("Instalar clave")');
  await page.locator('.modal').last().locator('.btn.primary:has-text("Instalar")').click();
  await page.waitForSelector('.macro-row:has-text("nexus_prueba_ui")');
  await page.waitForSelector('.toast:has-text("añadida a authorized_keys")');
  for (let i = 0; i < 50 && !(existsSync(join(root, '.ssh', 'authorized_keys')) && readFileSync(join(root, '.ssh', 'authorized_keys'), 'utf8')); i++) await page.waitForTimeout(100);
  assert.match(readFileSync(join(root, '.ssh', 'authorized_keys'), 'utf8'), /^ssh-ed25519 \S+ nexus-neo$/m);
  await page.locator('.modal .btn.primary:has-text("Cerrar")').click();
  console.log('✔ claves SSH');

  // Mosh (arranca mosh-server a través del servidor SSH de pruebas), si está instalado.
  let hasMosh = true;
  try {
    (await import('node:child_process')).execFileSync('mosh-server', ['--version'], { stdio: 'ignore' });
  } catch {
    hasMosh = false;
  }
  if (hasMosh) {
    await page.locator('#quick-connect').fill(`mosh://nexus@127.0.0.1:${srv.port}`);
    await page.locator('#quick-connect').press('Enter');
    await page.waitForSelector('.modal:has-text("Contraseña para")');
    await page.locator('.modal input[type=password]').fill('secreto');
    await page.click('.modal .btn.primary');
    await page.waitForSelector('.tab.active[data-state="connected"]:has-text("mosh://")', { timeout: 20000 });
    await page.locator('.pane.focused .xterm').click();
    await page.keyboard.type('echo MOSH_$((6*7))\n');
    await page.waitForFunction(() => document.querySelector('.pane.focused .xterm-rows')?.textContent?.includes('MOSH_42'), null, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('toasts')?.remove());
    await page.screenshot({ path: join(shots, '12-mosh.png') });
    await page.keyboard.press('Control+Shift+W');
    await page.click('.modal .btn.danger:has-text("Cerrar")');
    await page.waitForSelector('.tab:has-text("mosh://")', { state: 'detached' });
    console.log('✔ Mosh');
  } else console.log('… Mosh: mosh-server no está instalado');

  // Visor VNC integrado
  const vnc = await startFakeVnc();
  const qc = page.locator('#quick-connect');
  await qc.fill(`vnc://127.0.0.1:${vnc.port}`);
  const [vncWin] = await Promise.all([app.waitForEvent('window'), qc.press('Enter')]);
  vncWin.on('pageerror', (e: Error) => {
    errors.push(`[vnc] ${e.message}`);
    if (process.env.RFB_DEBUG) console.log('[vnc-error]', e.stack);
  });
  if (process.env.RFB_DEBUG) vncWin.on('console', (m) => console.log('[vnc-console]', m.text().slice(0, 160)));
  await vncWin.waitForSelector('#status.ok', { timeout: 15000 });
  await vncWin.waitForFunction(() => {
    const c = document.querySelector('#screen canvas') as HTMLCanvasElement | null;
    if (!c || c.width < 300) return false;
    const ctx = c.getContext('2d')!;
    const l = ctx.getImageData(10, 10, 1, 1).data;
    const r = ctx.getImageData(c.width - 10, 10, 1, 1).data;
    return l[0] > 200 && l[2] < 50 && r[2] > 200 && r[0] < 50;
  }, null, { timeout: 15000 });
  await vncWin.locator('#screen canvas').click();
  await vncWin.keyboard.press('a');
  for (let i = 0; i < 50 && !vnc.keys.length; i++) await vncWin.waitForTimeout(100);
  assert.ok(vnc.keys.includes(0x61), 'el servidor VNC debe recibir la tecla "a"');
  assert.ok(vnc.pointerEvents > 0, 'el servidor VNC debe recibir eventos de ratón');
  await vncWin.screenshot({ path: join(shots, '09-visor-vnc.png') });
  await vncWin.close();
  await vnc.close();
  console.log('✔ visor VNC integrado');

  // Visor RDP integrado (sólo si hay un servidor RDP de pruebas, p. ej. xrdp en CI).
  if (process.env.NEXUS_RDP_TEST) {
    await qc.fill(`rdp://usuario@${process.env.NEXUS_RDP_TEST}`);
    const [rdpWin] = await Promise.all([app.waitForEvent('window'), qc.press('Enter')]);
    rdpWin.on('pageerror', (e: Error) => errors.push(`[rdp] ${e.message}`));
    await rdpWin.waitForSelector('#login-box', { timeout: 15000 });
    await rdpWin.fill('#login-box input[type=password]', 'secreto');
    await rdpWin.click('#login-box .primary');
    await rdpWin.waitForSelector('#cert-box', { timeout: 15000 });
    await rdpWin.click('#cert-box .primary');
    await rdpWin.waitForSelector('#status.ok', { timeout: 30000 });
    await rdpWin.waitForFunction(() => {
      const c = document.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!c || c.width < 300) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const colors = new Set<number>();
      for (let i = 0; i < d.length && colors.size < 8; i += 4 * 97) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return colors.size >= 8;
    }, null, { timeout: 30000 });
    await rdpWin.screenshot({ path: join(shots, '19-visor-rdp.png') });
    await rdpWin.close();
    console.log('✔ visor RDP integrado');
  } else console.log('… visor RDP: sin servidor de pruebas (define NEXUS_RDP_TEST=host:puerto)');

  // Plugins: activar el de ejemplo, usar su comando y su reacción a la salida
  await page.click('#btn-settings');
  await page.click('#btn-plugins');
  await page.click('.pl-row[data-plugin="marcas-de-tiempo"] .btn:has-text("Activar")');
  await page.locator('.modal').last().locator('.btn.primary:has-text("Activar")').click();
  await page.waitForSelector('.pl-row.on[data-plugin="marcas-de-tiempo"]');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '17-plugins.png') });
  await page.locator('.modal').last().locator('.btn:has-text("Cerrar")').click();
  await page.locator('.modal').last().locator('.btn:has-text("Cancelar")').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).plugins['marcas-de-tiempo'].permissions.includes('terminal:write'));
  await page.locator('.pane:not(.hidden) .xterm').click();
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.type('Insertar fecha');
  await page.waitForSelector('.palette-list :text("Insertar fecha y hora")');
  await page.keyboard.press('Enter');
  // El comando escribe la fecha en el terminal activo (sin pulsar Intro).
  await waitTerm(page, ` ${new Date().getFullYear()}-`);
  await page.locator('.pane:not(.hidden) .xterm').click();
  await page.keyboard.press('Control+C');
  await page.keyboard.type('% Invalid input');
  await page.waitForSelector('#status-plugins:has-text("1 error")');
  await page.keyboard.press('Control+C');
  console.log('✔ plugins');

  // Temas: importar un esquema de Windows Terminal y usarlo
  await page.click('#btn-settings');
  await page.click('#btn-themes');
  await page.waitForSelector('.te-item[data-theme="plugin-marcas-de-tiempo-ambar-retro"]');
  await page.click('#te-import');
  await page.locator('.modal').last().locator('textarea').fill(JSON.stringify({ name: 'Campbell Plus', background: '#0C0C0C', foreground: '#CCCCCC', black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC', brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2' }));
  await page.locator('.modal').last().locator('.btn.primary:has-text("Importar")').click();
  await page.waitForSelector('.te-item.active:has-text("Campbell Plus")');
  await page.evaluate(() => document.getElementById('toasts')?.remove());
  await page.screenshot({ path: join(shots, '18-temas.png') });
  await page.locator('.modal').last().locator('.btn.primary:has-text("Usar este tema")').click();
  await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
  assert.equal(await page.locator('.modal .field:has-text("Tema") select').inputValue(), 'custom-campbell-plus');
  await page.click('.modal .btn.primary:has-text("Guardar")');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).theme, 'custom-campbell-plus');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text').trim()), '#cccccc');
  console.log('✔ temas personalizados');

  // Tema claro
  await page.click('#btn-settings');
  await page.locator('.modal .field:has-text("Tema") select').selectOption('nexus-light');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.screenshot({ path: join(shots, '06-tema-claro.png') });
  console.log('✔ ajustes y temas');

  assert.deepEqual(errors, [], `errores en la página: ${errors.join('\n')}`);
  await app.close();
  await srv.close();
  console.log(`Capturas en ${shots}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
