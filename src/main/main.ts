import { app, BrowserWindow, dialog, ipcMain, shell, Menu, IpcMainInvokeEvent } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { Vault } from './vault';
import { TerminalConnection, Prompter } from './protocols/base';
import { SshConnection, SshDeps, connectClient } from './protocols/ssh';
import { VncBridge } from './vnc-bridge';
import { RdpGateway } from './rdp/gateway';
import { LocalConnection, detectShells } from './protocols/local';
import { TelnetConnection } from './protocols/telnet';
import { MoshConnection } from './protocols/mosh';
import { SerialConnection, listSerialPorts } from './protocols/serial';
import { launchExternal } from './protocols/external';
import * as sftpOps from './sftp-ops';
import { SessionLogger } from './session-log';
import { generateKey, installPublicKey, listKeys, sshDir, KeyType } from './keys';
import { checkKeyPermissions, importKeyFile, protectKeyFile } from './key-perms';
import { ServerManager, defaultServers, listInterfaces } from './servers/manager';
import { buildNexusExport, parseNexusExport, parseSshConfig } from './importers';
import type { AuthPrompt, HostKeyPrompt, Macro, OpenRequest, SecretEntry, ServerConfig, SessionConfig, Settings, TunnelConfig } from '../shared/types';

// ---------------------------------------------------------------------------
// Directorio de datos: modo portable si existe un archivo "portable" junto al ejecutable.
function dataDir(): string {
  if (process.env.NEXUS_NEO_DATA_DIR) return process.env.NEXUS_NEO_DATA_DIR;
  const exeDir = dirname(process.execPath);
  if (existsSync(join(exeDir, 'portable'))) return join(exeDir, 'data');
  return join(app.getPath('userData'), 'data');
}

let store: Store;
let vault: Vault;
let win: BrowserWindow | null = null;
const conns = new Map<string, TerminalConnection>();
const pending = new Map<string, (v: unknown) => void>();
const servers = new ServerManager();
/** Contraseñas FTP cuando la bóveda no está disponible (sólo en memoria). */
const serverPasswords = new Map<string, string>();
let lastActivity = Date.now();

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function ask<T>(channel: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    const id = randomUUID();
    pending.set(id, resolve as (v: unknown) => void);
    send(channel, id, payload);
  });
}

function prompterFor(connId: string): Prompter {
  return {
    hostKey: (p: HostKeyPrompt) => ask<boolean>('prompt:hostKey', { connId, ...p }),
    auth: (p: AuthPrompt) => ask<string[] | null>('prompt:auth', { connId, ...p }),
  };
}

function sshDeps(connId: string, sessions: SessionConfig[]): SshDeps {
  return {
    prompter: prompterFor(connId),
    knownHosts: { get: (id) => store.knownHost(id), set: (id, fp) => store.setKnownHost(id, fp) },
    secretFor: (id) => (vault.isUnlocked() ? vault.get(id) : undefined),
    sessionById: (id) => sessions.find((s) => s.id === id),
    onTunnelsChanged: () => send('tunnels:changed', allTunnelStatus()),
  };
}

// --- Visor VNC integrado -----------------------------------------------------
const vncWindows = new Map<string, { cfg: SessionConfig; bridge?: VncBridge }>();

function openVncWindow(cfg: SessionConfig): void {
  const id = randomUUID();
  vncWindows.set(id, { cfg });
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0b0f14',
    title: `${cfg.name} — VNC · Nexus Neo`,
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenu(null);
  void w.loadFile(join(__dirname, 'renderer/vnc.html'), { query: process.env.NEXUS_NEO_VNC_DEBUG ? { id, debug: '1' } : { id } });
  w.on('closed', () => {
    vncWindows.get(id)?.bridge?.close();
    vncWindows.delete(id);
  });
}

// --- Visor RDP integrado -----------------------------------------------------
// IronRDP (WebAssembly) dibuja el escritorio en una ventana propia y habla con el servidor a
// través de la pasarela RDCleanPath local, que hace el TCP/TLS (o el túnel SSH).
const rdpGateway = new RdpGateway();
const rdpWindows = new Map<string, { cfg: SessionConfig; win: BrowserWindow; token?: string; ssh?: import('ssh2').Client }>();

/** Pregunta algo a una ventana concreta y espera su respuesta por prompt:reply. */
function askWindow<T>(w: BrowserWindow, channel: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    const id = randomUUID();
    pending.set(id, resolve as (v: unknown) => void);
    if (w.isDestroyed()) return resolve(false as T);
    w.webContents.send(channel, id, payload);
    w.once('closed', () => {
      if (pending.delete(id)) resolve(false as T);
    });
  });
}

function openRdpWindow(cfg: SessionConfig): void {
  const id = randomUUID();
  const [w0, h0] = (cfg.rdpResolution || '').split('x').map(Number);
  const w = new BrowserWindow({
    width: w0 > 0 ? Math.min(w0 + 16, 3840) : 1366,
    height: h0 > 0 ? Math.min(h0 + 60, 2160) : 860,
    backgroundColor: '#0b0f14',
    title: `${cfg.name} — RDP · Nexus Neo`,
    icon: windowIcon(),
    autoHideMenuBar: true,
    fullscreen: !!cfg.rdpFullscreen,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenu(null);
  rdpWindows.set(id, { cfg, win: w });
  void w.loadFile(join(__dirname, 'renderer/rdp.html'), { query: { id } });
  w.on('closed', () => {
    const e = rdpWindows.get(id);
    if (e?.token) rdpGateway.revoke(e.token);
    e?.ssh?.end();
    rdpWindows.delete(id);
  });
}

function sshConn(connId: string): SshConnection {
  const c = conns.get(connId);
  if (!(c instanceof SshConnection)) throw new Error('La pestaña no es una sesión SSH conectada.');
  return c;
}

function allTunnelStatus() {
  return [...conns.values()].flatMap((c) =>
    c instanceof SshConnection && c.tunnels
      ? c.tunnels.status().map((t) => ({ ...t, sessionName: c.cfg.name }))
      : [],
  );
}

// ---------------------------------------------------------------------------
/** Icono de ventana y barra de tareas (en Windows el .exe ya lleva el .ico). */
function windowIcon(): string | undefined {
  const p = join(__dirname, 'icon.png');
  return existsSync(p) ? p : undefined;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0f1419',
    title: 'Nexus Neo',
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(join(__dirname, 'renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    for (const c of conns.values()) c.close();
    conns.clear();
  });
  if (process.env.NEXUS_NEO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    lastActivity = Date.now();
    return fn(...args);
  });
}

function registerIpc(): void {
  handle('app:info', async () => ({
    platform: process.platform,
    version: app.getVersion(),
    shells: detectShells(),
    dataDir: store.dir,
    home: homedir(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  }));
  handle('app:quit', async () => {
    await servers.stopAll().catch(() => undefined);
    app.quit();
  });

  // --- Sesiones -------------------------------------------------------------
  handle('sessions:list', () => store.listSessions());
  handle('sessions:save', async (s: SessionConfig, secret?: SecretEntry | null) => {
    const saved = await store.saveSession(s);
    if (secret && (secret.password || secret.passphrase)) {
      if (!vault.isUnlocked()) throw new Error('Desbloquea o crea la bóveda para guardar contraseñas.');
      await vault.set(saved.id, secret);
    }
    return saved;
  });
  handle('sessions:clearSecret', async (id: string) => vault.remove(id));
  handle('sessions:delete', async (id: string) => {
    await store.deleteSession(id);
    await vault.remove(id);
  });
  handle('sessions:hasSecret', (id: string) => vault.has(id));
  handle('sessions:import', async (kind: 'ssh-config' | 'file') => {
    let sessions: SessionConfig[];
    if (kind === 'ssh-config') {
      const path = join(homedir(), '.ssh', 'config');
      if (!existsSync(path)) throw new Error(`No se encontró ${path}`);
      sessions = parseSshConfig(await fs.readFile(path, 'utf8'));
    } else {
      const r = await dialog.showOpenDialog(win!, { title: 'Importar sesiones', filters: [{ name: 'Nexus Neo', extensions: ['json'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { imported: 0, skipped: 0, sessions: [] };
      sessions = parseNexusExport(await fs.readFile(r.filePaths[0], 'utf8'));
    }
    await store.addSessions(sessions);
    return { imported: sessions.length, skipped: 0, sessions };
  });
  handle('sessions:export', async () => {
    const r = await dialog.showSaveDialog(win!, { title: 'Exportar sesiones', defaultPath: 'nexus-neo-sesiones.json' });
    if (r.canceled || !r.filePath) return false;
    await fs.writeFile(r.filePath, buildNexusExport(await store.listSessions()));
    return true;
  });

  // --- Macros y ajustes ----------------------------------------------------
  handle('macros:list', () => store.listMacros());
  handle('macros:save', (m: Macro) => store.saveMacro(m));
  handle('macros:delete', (id: string) => store.deleteMacro(id));
  handle('settings:get', () => store.getSettings());
  handle('settings:save', (s: Partial<Settings>) => store.saveSettings(s));

  // --- Bóveda --------------------------------------------------------------
  handle('vault:status', async () => ({ exists: await vault.exists(), unlocked: vault.isUnlocked() }));
  handle('vault:create', (pw: string) => vault.create(pw));
  handle('vault:unlock', (pw: string) => vault.unlock(pw));
  handle('vault:lock', () => vault.lock());
  handle('vault:change', (oldPw: string, newPw: string) => vault.changePassword(oldPw, newPw));

  // --- Conexiones ----------------------------------------------------------
  handle('conn:open', async (connId: string, req: OpenRequest) => {
    const cfg = req.session;
    const settings = await store.getSettings();
    if (cfg.kind === 'vnc' && !cfg.vncExternal) {
      openVncWindow(cfg);
      return;
    }
    if (cfg.kind === 'rdp' && !cfg.rdpExternal && !settings.rdpClient) {
      openRdpWindow(cfg);
      return;
    }
    if (cfg.kind === 'rdp' || cfg.kind === 'vnc') {
      await launchExternal(cfg, settings);
      return;
    }
    let conn: TerminalConnection;
    const sessionsSnapshot = await store.listSessions();
    switch (cfg.kind) {
      case 'ssh':
        conn = new SshConnection(cfg, sshDeps(connId, sessionsSnapshot), connId);
        break;
      case 'mosh':
        conn = new MoshConnection(cfg, sshDeps(connId, sessionsSnapshot));
        break;
      case 'local':
        conn = new LocalConnection(cfg, settings.defaultLocalShell);
        break;
      case 'telnet':
        conn = new TelnetConnection(cfg);
        break;
      case 'serial':
        conn = new SerialConnection(cfg);
        break;
      default:
        throw new Error(`Tipo de sesión no soportado: ${cfg.kind}`);
    }
    conns.set(connId, conn);
    let logger: SessionLogger | null = null;
    if (settings.logAllSessions || cfg.logSession) {
      try {
        logger = new SessionLogger(settings.logDir || join(store.dir, 'logs'), cfg.name, settings.logStripAnsi);
      } catch (e) {
        send('conn:data', connId, `\x1b[33m⚠ No se pudo crear el registro de sesión: ${(e as Error).message}\x1b[0m\r\n`);
      }
    }
    conn.on('data', (d: string) => {
      send('conn:data', connId, d);
      logger?.write(d);
    });
    conn.on('state', (s: string, msg?: string) => {
      if ((s === 'closed' || s === 'error') && logger) {
        logger.close();
        logger = null;
      }
      send('conn:state', connId, s, msg);
      if (s === 'closed' && conn instanceof SshConnection) send('tunnels:changed', allTunnelStatus());
    });
    try {
      await conn.open(req.cols, req.rows);
    } catch (e) {
      conns.delete(connId);
      conn.close();
      logger?.close();
      throw e;
    }
  });
  ipcMain.on('conn:write', (_e, connId: string, data: string) => {
    lastActivity = Date.now();
    conns.get(connId)?.write(data);
  });
  ipcMain.on('conn:resize', (_e, connId: string, cols: number, rows: number) => conns.get(connId)?.resize(cols, rows));
  handle('conn:close', (connId: string) => {
    conns.get(connId)?.close();
    conns.delete(connId);
    send('tunnels:changed', allTunnelStatus());
  });
  ipcMain.on('prompt:reply', (_e, id: string, value: unknown) => {
    pending.get(id)?.(value);
    pending.delete(id);
  });
  handle('serial:list', () => listSerialPorts());

  // --- Túneles -------------------------------------------------------------
  handle('tunnels:list', () => allTunnelStatus());
  handle('tunnels:start', (connId: string, tid: string) => sshConn(connId).tunnels!.start(tid));
  handle('tunnels:stop', (connId: string, tid: string) => sshConn(connId).tunnels!.stop(tid));
  handle('tunnels:add', async (connId: string, t: TunnelConfig) => {
    const c = sshConn(connId);
    const cfg = { ...t, id: t.id || randomUUID() };
    c.tunnels!.add(cfg);
    await c.tunnels!.start(cfg.id);
  });

  // --- SFTP ----------------------------------------------------------------
  const sftp = (connId: string) => sshConn(connId).sftp();
  handle('sftp:home', async (connId: string) => sftpOps.realpath(await sftp(connId), '.'));
  handle('sftp:list', async (connId: string, path: string) => sftpOps.list(await sftp(connId), path));
  handle('sftp:mkdir', async (connId: string, path: string) => sftpOps.mkdir(await sftp(connId), path));
  handle('sftp:rename', async (connId: string, a: string, b: string) => sftpOps.rename(await sftp(connId), a, b));
  handle('sftp:chmod', async (connId: string, path: string, mode: number) => sftpOps.chmod(await sftp(connId), path, mode));
  handle('sftp:delete', async (connId: string, path: string, isDir: boolean) => sftpOps.remove(await sftp(connId), path, isDir));
  handle('sftp:readText', async (connId: string, path: string) => sftpOps.readText(await sftp(connId), path));
  handle('sftp:writeText', async (connId: string, path: string, content: string) => sftpOps.writeText(await sftp(connId), path, content));
  const progress = (connId: string) => (file: string, transferred: number, total: number) =>
    send('sftp:progress', connId, { file, transferred, total });
  handle('sftp:download', async (connId: string, remotePaths: string[]) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Descargar en…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return false;
    const s = await sftp(connId);
    for (const rp of remotePaths) await sftpOps.download(s, rp, r.filePaths[0], progress(connId));
    return r.filePaths[0];
  });
  handle('sftp:upload', async (connId: string, remoteDir: string, localPaths?: string[]) => {
    let paths = localPaths;
    if (!paths || paths.length === 0) {
      const r = await dialog.showOpenDialog(win!, { title: 'Subir archivos', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return false;
      paths = r.filePaths;
    }
    const s = await sftp(connId);
    for (const lp of paths) await sftpOps.upload(s, lp, remoteDir, progress(connId));
    return true;
  });

  // --- Monitor remoto ------------------------------------------------------
  handle('monitor:stats', async (connId: string) => {
    const out = await sshConn(connId).exec(
      "cat /proc/loadavg 2>/dev/null; echo '--'; free -m 2>/dev/null | awk 'NR==2{print $2\" \"$3}'; echo '--'; df -P / 2>/dev/null | awk 'NR==2{print $5}'; echo '--'; cat /proc/uptime 2>/dev/null; echo '--'; nproc 2>/dev/null",
    );
    const [load, mem, disk, up, cpus] = out.split('--').map((s) => s.trim());
    const [memTotal, memUsed] = (mem || '').split(' ').map(Number);
    return {
      load: load ? Number(load.split(' ')[0]) : null,
      cpus: Number(cpus) || null,
      memTotal: memTotal || null,
      memUsed: memUsed || null,
      disk: disk || null,
      uptimeSec: up ? Math.floor(Number(up.split(' ')[0])) : null,
    };
  });

  // --- Servidores integrados ---------------------------------------------
  const serverList = async (): Promise<ServerConfig[]> => {
    let list = await store.listServers();
    if (!list) {
      list = defaultServers();
      await store.saveServers(list);
    }
    return list;
  };
  const serverPassword = (id: string): string | undefined =>
    serverPasswords.get(id) ?? (vault.isUnlocked() ? vault.get(`server:${id}`)?.password : undefined);
  servers.on('status', async () => send('servers:status', servers.status(await serverList())));
  servers.on('log', (e) => send('servers:log', e));
  handle('servers:list', async () => {
    const list = await serverList();
    return {
      configs: list.map((c) => ({ ...c, password: undefined, hasPassword: !!serverPassword(c.id) })),
      status: servers.status(list),
      logs: servers.recentLogs(),
      interfaces: listInterfaces(),
      vaultUnlocked: vault.isUnlocked(),
    };
  });
  handle('servers:save', async (cfg: ServerConfig) => {
    const list = await serverList();
    const i = list.findIndex((c) => c.id === cfg.id);
    if (i < 0) throw new Error('Servidor desconocido');
    if (servers.isRunning(cfg.id)) throw new Error('Detén el servidor antes de cambiar su configuración.');
    if (cfg.password) {
      if (vault.isUnlocked()) {
        await vault.set(`server:${cfg.id}`, { password: cfg.password });
        serverPasswords.delete(cfg.id);
      } else serverPasswords.set(cfg.id, cfg.password);
    }
    list[i] = { ...list[i], ...cfg, id: list[i].id, kind: list[i].kind, password: undefined };
    await store.saveServers(list);
  });
  handle('servers:start', async (id: string) => {
    const cfg = (await serverList()).find((c) => c.id === id);
    if (!cfg) throw new Error('Servidor desconocido');
    await servers.start({ ...cfg, password: serverPassword(id) });
  });
  handle('servers:stop', (id: string) => servers.stop(id));
  handle('servers:clearLogs', () => servers.clearLogs());
  handle('dialog:pickDir', async (title: string, current?: string) => {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:openPath', async (p: string) => {
    await fs.mkdir(p, { recursive: true }).catch(() => undefined);
    return shell.openPath(p);
  });
  handle('logs:dir', async () => (await store.getSettings()).logDir || join(store.dir, 'logs'));

  // --- RDP ---------------------------------------------------------------
  ipcMain.handle('rdp:prepare', async (_e, id: string) => {
    const entry = rdpWindows.get(id);
    if (!entry) throw new Error('Sesión RDP desconocida');
    const { cfg, win: w } = entry;
    const host = cfg.host || 'localhost';
    const port = cfg.port || 3389;
    await rdpGateway.start();
    let via = '';
    let openTransport: (() => Promise<import('node:stream').Duplex>) | undefined;
    if (cfg.jumpSessionId) {
      const sessions = await store.listSessions();
      const jump = sessions.find((s) => s.id === cfg.jumpSessionId);
      if (!jump) throw new Error('La sesión SSH del túnel no existe.');
      via = ` a través de ${jump.name}`;
      openTransport = async () => {
        entry.ssh?.end();
        const ssh = await connectClient(jump, sshDeps(`rdp-${id}`, sessions));
        entry.ssh = ssh;
        return new Promise((resolve, reject) =>
          ssh.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))));
      };
    }
    if (entry.token) rdpGateway.revoke(entry.token);
    const { url, token } = rdpGateway.issue({
      host,
      port,
      openTransport,
      verifyCertificate: async (c) => {
        const kid = `rdp:[${c.host}]:${c.port}`;
        const known = store.knownHost(kid);
        if (known === c.fingerprint) return true;
        const ok = await askWindow<boolean>(w, 'rdp:cert', { ...c, previous: known });
        if (ok) await store.setKnownHost(kid, c.fingerprint);
        return ok;
      },
    });
    entry.token = token;
    const secret = vault.isUnlocked() ? vault.get(cfg.id) : undefined;
    const [width, height] = (cfg.rdpResolution || '').split('x').map(Number);
    return {
      name: cfg.name,
      target: `${host}:${port}${via}`,
      destination: `${host}:${port}`,
      url,
      token,
      username: cfg.username || '',
      domain: cfg.rdpDomain || '',
      password: secret?.password ?? null,
      canSave: vault.isUnlocked() && !cfg.id.startsWith('quick-'),
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0,
    };
  });
  ipcMain.handle('rdp:savePassword', async (_e, id: string, password: string) => {
    const entry = rdpWindows.get(id);
    if (!entry || !vault.isUnlocked()) return false;
    await vault.set(entry.cfg.id, { ...(vault.get(entry.cfg.id) || {}), password });
    return true;
  });
  ipcMain.on('rdp:activity', () => (lastActivity = Date.now()));

  // --- VNC ---------------------------------------------------------------
  ipcMain.handle('vnc:connect', async (e, id: string) => {
    const entry = vncWindows.get(id);
    if (!entry) throw new Error('Sesión VNC desconocida');
    const { cfg } = entry;
    const host = cfg.host || 'localhost';
    const port = cfg.port || 5900;
    let ssh;
    let via = '';
    if (cfg.jumpSessionId) {
      const sessions = await store.listSessions();
      const jump = sessions.find((s) => s.id === cfg.jumpSessionId);
      if (!jump) throw new Error('La sesión SSH del túnel no existe.');
      ssh = await connectClient(jump, sshDeps(`vnc-${id}`, sessions));
      via = ` a través de ${jump.name}`;
    }
    const bridge = new VncBridge(
      { host, port, ssh },
      (chunk) => !e.sender.isDestroyed() && e.sender.send('vnc:data', chunk),
      (reason) => !e.sender.isDestroyed() && e.sender.send('vnc:closed', reason),
    );
    await bridge.open();
    entry.bridge = bridge;
    return { name: cfg.name, target: `${host}:${port}${via}`, viewOnly: false };
  });
  ipcMain.on('vnc:write', (_e, id: string, data: Uint8Array) => {
    lastActivity = Date.now();
    vncWindows.get(id)?.bridge?.write(data);
  });
  ipcMain.handle('vnc:secret', (_e, id: string) => {
    const entry = vncWindows.get(id);
    return entry && vault.isUnlocked() ? vault.get(entry.cfg.id)?.password ?? null : null;
  });
  ipcMain.handle('vnc:disconnect', (_e, id: string) => vncWindows.get(id)?.bridge?.close());

  // --- Claves SSH ----------------------------------------------------------
  handle('keys:list', async () => ({ dir: sshDir(), keys: await listKeys() }));
  handle('keys:generate', (o: { type: KeyType; bits?: number; comment?: string; passphrase?: string; name: string; overwrite?: boolean }) => {
    if (!/^[\w.@-]+$/.test(o.name)) throw new Error('Nombre de archivo no válido.');
    return generateKey({ ...o, path: join(sshDir(), o.name) });
  });
  handle('keys:install', async (connId: string, publicKey: string) => installPublicKey(await sshConn(connId).sftp(), publicKey));
  handle('keys:checkPerms', (path: string) => checkKeyPermissions(path));
  handle('keys:fixPerms', (path: string) => protectKeyFile(path));
  handle('keys:import', async (src?: string, overwrite?: boolean) => {
    if (!src) {
      const r = await dialog.showOpenDialog(win!, { title: 'Importar clave privada', defaultPath: homedir(), properties: ['openFile', 'showHiddenFiles'] });
      if (r.canceled || !r.filePaths[0]) return null;
      src = r.filePaths[0];
    }
    return importKeyFile(src, sshDir(), { overwrite });
  });
  handle('keys:openDir', async () => {
    await fs.mkdir(sshDir(), { recursive: true, mode: 0o700 });
    return shell.openPath(sshDir());
  });

  // --- Utilidades ----------------------------------------------------------
  handle('dialog:pickFile', async (title: string) => {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
}

// Bloqueo automático de la bóveda por inactividad.
setInterval(async () => {
  if (!vault?.isUnlocked()) return;
  const s = await store.getSettings();
  if (s.vaultAutoLockMin > 0 && Date.now() - lastActivity > s.vaultAutoLockMin * 60_000) {
    vault.lock();
    send('vault:locked');
  }
}, 60_000).unref();

app.whenReady().then(async () => {
  store = new Store(dataDir());
  await store.init();
  vault = new Vault(join(store.dir, 'vault.json'));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  void Promise.all([servers.stopAll(), rdpGateway.stop()]).finally(() => app.quit());
});
