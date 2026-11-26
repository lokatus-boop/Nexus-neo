// Prueba de humo de la interfaz: arranca la app real de Electron con Playwright
// y recorre los flujos principales contra un servidor SSH de pruebas.
import { _electron as electron, Page } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/ssh-server';

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

  const { createRequire } = await import('node:module');
  const executablePath = createRequire(join(process.cwd(), 'package.json'))('electron') as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: ['.', '--no-sandbox'],
    env: { ...process.env, NEXUS_NEO_DATA_DIR: dataDir, SHELL: '/bin/bash' },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.waitForSelector('#welcome .card-btn');
  await page.screenshot({ path: join(shots, '01-bienvenida.png') });
  console.log('✔ pantalla de bienvenida');

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
  await page.keyboard.press('Control+Shift+E');
  console.log('✔ servidores TFTP y Syslog');

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
