// Tipos compartidos entre el proceso principal, el preload y la interfaz.

export type SessionKind = 'ssh' | 'mosh' | 'local' | 'telnet' | 'serial' | 'rdp' | 'vnc';

export type TunnelType = 'local' | 'remote' | 'dynamic';

export interface TunnelConfig {
  id: string;
  name: string;
  type: TunnelType;
  /** Dirección donde se escucha (local para L/D, remota para R). */
  bindHost: string;
  bindPort: number;
  /** Destino (no aplica a túneles dinámicos SOCKS). */
  destHost: string;
  destPort: number;
  autoStart: boolean;
}

export type SshAuth = 'password' | 'key' | 'agent';

export interface SessionConfig {
  id: string;
  name: string;
  /** Carpeta en el árbol de sesiones, separada por "/". */
  folder: string;
  kind: SessionKind;
  /** Última modificación (ms); la usa la sincronización para resolver conflictos. */
  updatedAt?: number;
  color?: string;
  notes?: string;

  // Red (ssh, telnet, rdp, vnc)
  host?: string;
  port?: number;
  username?: string;

  // SSH
  auth?: SshAuth;
  keyPath?: string;
  /** Id de otra sesión SSH a usar como salto (ProxyJump). */
  jumpSessionId?: string;
  /** Reenvío X11 (activado salvo que valga false). */
  x11?: boolean;
  /** Pantalla X local a usar (por defecto, DISPLAY del sistema o la detectada). */
  x11Display?: string;
  keepAliveSec?: number;
  tunnels?: TunnelConfig[];
  /** Guarda la salida de esta sesión en un archivo de registro. */
  logSession?: boolean;
  /** Abre el panel SFTP automáticamente al conectar. */
  autoSftp?: boolean;
  /** Macro que se ejecuta al abrir la sesión. */
  startupMacroId?: string;
  /** Terminal remoto solicitado (TERM). */
  term?: string;

  // Mosh (usa también los campos de autenticación SSH)
  /** Ruta o nombre de mosh-server en el servidor. */
  moshServer?: string;
  /** Puerto o rango UDP para mosh-server, p. ej. "60000:60100". */
  moshPorts?: string;
  /** Orden a ejecutar en lugar del shell (p. ej. "tmux new -A -s main"). */
  moshCommand?: string;
  /** Locale UTF-8 para mosh-server (por defecto C.UTF-8). */
  moshLocale?: string;
  /** Host o IP para el UDP si difiere del de SSH. */
  moshHost?: string;

  // Local
  shell?: string;
  shellArgs?: string[];
  cwd?: string;

  // Serie
  serialPath?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  localEcho?: boolean;

  /** VNC: usar el cliente externo en lugar del visor integrado. */
  vncExternal?: boolean;
  /** VNC: sólo ver (no enviar teclado ni ratón). */
  vncViewOnly?: boolean;

  // RDP / VNC
  rdpFullscreen?: boolean;
  rdpResolution?: string;
  /** RDP: dominio de Windows (opcional). */
  rdpDomain?: string;
  /** RDP: abrir con el cliente del sistema (mstsc/xfreerdp) en lugar del visor integrado. */
  rdpExternal?: boolean;
}

export interface Macro {
  id: string;
  name: string;
  /**
   * Pasos de la macro. Texto literal; admite las secuencias
   * \n \r \t \e y la directiva {sleep:ms}.
   */
  body: string;
  shortcut?: string;
  updatedAt?: number;
}

export interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'bar' | 'underline';
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  confirmOnClose: boolean;
  defaultLocalShell: string;
  rdpClient: string;
  vncClient: string;
  /** Minutos de inactividad para bloquear la bóveda (0 = nunca). */
  vaultAutoLockMin: number;
  /** Guarda la salida de todas las sesiones en archivos de registro. */
  logAllSessions: boolean;
  /** Carpeta de registros (vacío = carpeta de datos/logs). */
  logDir: string;
  /** Quita colores y secuencias de control de los registros. */
  logStripAnsi: boolean;
  /** Reintenta conectar automáticamente si se cae una sesión remota. */
  autoReconnect: boolean;
  /** Versión del aviso legal aceptada por el usuario (0 = sin aceptar). */
  disclaimerAccepted: number;
  /** Sincronización cifrada de sesiones entre equipos. */
  sync: SyncSettings;
  backupSchedule: BackupSchedule;
  /** Carpeta de los respaldos de configuración (por defecto, dentro de los datos de la app). */
  backupDir?: string;
  /** Plugins activados y los permisos que se les han concedido. */
  plugins: Record<string, { permissions: PluginPermission[] }>;
}

export interface SecretEntry {
  password?: string;
  passphrase?: string;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number;
  mode: number;
  permissions: string;
}

export interface TunnelStatus {
  connId: string;
  tunnelId: string;
  name: string;
  type: TunnelType;
  description: string;
  state: 'stopped' | 'listening' | 'error';
  error?: string;
  activeConnections: number;
}

export type ConnState = 'connecting' | 'connected' | 'closed' | 'error';

export interface HostKeyPrompt {
  host: string;
  port: number;
  fingerprint: string;
  algorithm: string;
  /** Huella conocida previamente si ha cambiado. */
  previous?: string;
}

export interface AuthPrompt {
  title: string;
  instructions?: string;
  prompts: { prompt: string; echo: boolean }[];
}

export interface OpenRequest {
  session: SessionConfig;
  cols: number;
  rows: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  sessions: SessionConfig[];
}

// ---------------------------------------------------------------------------
// Servidores integrados (TFTP, FTP, HTTP, HTTPS, SFTP/SCP, Syslog, DHCP)

export type ServerKind = 'tftp' | 'ftp' | 'http' | 'https' | 'sftp' | 'syslog' | 'dhcp';

export interface DhcpReservation {
  mac: string;
  ip: string;
  name?: string;
}

export interface DhcpLease {
  mac: string;
  ip: string;
  hostname?: string;
  /** Marca de tiempo (ms) en la que caduca. */
  expires: number;
  /** Ofrecida pero aún sin confirmar (DHCPOFFER sin REQUEST). */
  offered?: boolean;
  reserved?: boolean;
}

export interface ServerConfig {
  id: string;
  kind: ServerKind;
  name: string;
  /** Carpeta raíz servida (o donde se guardan los logs en Syslog). */
  rootDir: string;
  port: number;
  bindHost: string;
  /** Permite subir/sobrescribir archivos (TFTP WRQ, FTP STOR, HTTP PUT). */
  allowWrite: boolean;
  // FTP
  anonymous?: boolean;
  username?: string;
  password?: string;
  pasvMin?: number;
  pasvMax?: number;
  // Syslog
  syslogTcp?: boolean;
  syslogToFile?: boolean;
  // HTTPS: certificado propio (PEM). Si se dejan vacíos se genera uno autofirmado.
  tlsCertPath?: string;
  tlsKeyPath?: string;
  // SFTP/SCP: claves públicas OpenSSH admitidas además de la contraseña (una por línea).
  authorizedKeys?: string;
  // DHCP
  dhcpPoolStart?: string;
  dhcpPoolEnd?: string;
  dhcpSubnetMask?: string;
  dhcpRouter?: string;
  /** Servidores DNS separados por comas. */
  dhcpDns?: string;
  dhcpDomain?: string;
  dhcpLeaseSecs?: number;
  /** Opción 66 (servidor TFTP) y 67 (archivo de arranque) para teléfonos IP, PXE y ZTP. */
  dhcpTftpServer?: string;
  dhcpBootFile?: string;
  dhcpReservations?: DhcpReservation[];
}

export interface ServerStatus {
  id: string;
  running: boolean;
  error?: string;
  /** Transferencias/conexiones activas. */
  active: number;
  /** Sólo DHCP: concesiones vigentes. */
  leases?: DhcpLease[];
}

export interface ServerLogEntry {
  serverId: string;
  time: number;
  level: 'info' | 'warn' | 'error' | 'transfer' | 'syslog';
  message: string;
  /** Sólo Syslog: datos del mensaje recibido. */
  syslog?: { from: string; facility: number; severity: number; text: string };
}

export interface NetInterfaceInfo {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
}

// ---------------------------------------------------------------------------
// Sincronización cifrada entre equipos

export interface SyncSettings {
  enabled: boolean;
  /** Carpeta compartida (Dropbox, OneDrive, Syncthing, NAS…) o servidor SFTP. */
  mode: 'folder' | 'sftp';
  /** Carpeta local (modo folder) o ruta remota (modo sftp) del archivo de sincronización. */
  path: string;
  /** Sesión SSH guardada para el modo sftp. */
  sessionId?: string;
  /** Sincroniza también las contraseñas de la bóveda (siempre cifradas). */
  includeSecrets: boolean;
  /** Minutos entre sincronizaciones automáticas (0 = sólo manual y al cambiar algo). */
  intervalMin: number;
  /** Nombre de este equipo en el archivo de sincronización. */
  deviceName: string;
}

export interface SyncStatus {
  configured: boolean;
  hasPassphrase: boolean;
  running: boolean;
  lastSync?: number;
  lastError?: string;
  lastResult?: SyncResult;
}

export interface SyncResult {
  /** Cambios aplicados en este equipo. */
  added: number;
  updated: number;
  removed: number;
  /** Equipos que han escrito en el archivo. */
  devices: string[];
  /** Fecha del archivo remoto tras sincronizar. */
  time: number;
}

// ---------------------------------------------------------------------------
// Despliegue masivo y respaldo de configuraciones de equipos de red

export interface NetDevice {
  id: string;
  name: string;
  host: string;
  port?: number;
  protocol: 'ssh' | 'telnet';
  /** Sesión guardada de la que se toman usuario, clave, bastión y contraseña de la bóveda. */
  sessionId?: string;
  username?: string;
  /** Perfil de fabricante (para los respaldos). */
  vendor?: string;
  /** Variables propias del equipo (columnas extra del CSV). */
  vars?: Record<string, string>;
}

export interface DeployJob {
  name: string;
  devices: NetDevice[];
  /** Órdenes (una por línea) con variables {{…}} y directivas !espera, !intro, !timeout, !enviar. */
  commands: string;
  /** Subida previa de un archivo (firmware, configuración…) por SFTP o SCP. */
  upload?: { localPath: string; remotePath: string; method: 'sftp' | 'scp' };
  /** Credenciales para los equipos que no vienen de una sesión guardada. */
  credentials?: { username?: string; password?: string };
  enablePassword?: string;
  concurrency: number;
  timeoutSec: number;
  prompt?: string;
  stopOnError: boolean;
  /** Expresión regular que marca una orden como fallida. */
  errorPattern?: string;
  /** Acepta (y guarda) automáticamente las huellas SSH de equipos nuevos; nunca las cambiadas. */
  acceptNewHostKeys: boolean;
  /** Variables comunes a todos los equipos. */
  vars?: Record<string, string>;
}

export type DeviceRunStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';

export interface DeviceRunResult {
  deviceId: string;
  name: string;
  host: string;
  status: DeviceRunStatus;
  message?: string;
  output: string;
  startedAt?: number;
  endedAt?: number;
  logFile?: string;
  /** Sólo respaldos: archivo guardado y si cambió respecto al anterior. */
  backupFile?: string;
  changed?: boolean;
}

export interface JobProgress {
  jobId: string;
  kind: 'deploy' | 'backup';
  name: string;
  dir: string;
  results: DeviceRunResult[];
  done: boolean;
}

export interface BackupJob {
  name: string;
  devices: NetDevice[];
  credentials?: { username?: string; password?: string };
  enablePassword?: string;
  concurrency: number;
  timeoutSec: number;
  prompt?: string;
  acceptNewHostKeys: boolean;
  /** Orden propia en lugar de la del perfil de fabricante. */
  command?: string;
}

export interface BackupEntry {
  device: string;
  file: string;
  time: number;
  size: number;
}

/** Plantilla de configuración con variables {{…}} que se rellena por equipo. */
export interface ConfigTemplate {
  id: string;
  name: string;
  vendor?: string;
  description?: string;
  body: string;
  updatedAt?: number;
}

/** Respaldo programado: equipos (sesiones guardadas) y cada cuántas horas. */
export interface BackupSchedule {
  enabled: boolean;
  everyHours: number;
  /** Ids de sesiones SSH/Telnet guardadas con su perfil de fabricante. */
  devices: { sessionId: string; vendor: string }[];
  lastRun?: number;
}

// ---------------------------------------------------------------------------
// Temas y plugins

/** Tema de la interfaz y del terminal (los integrados, los propios y los de plugins). */
export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  /** Colores de la interfaz: bg, panel, panel2, border, text, muted, accent, accent2, danger, warn. */
  ui: Record<string, string>;
  /** Colores del terminal (formato xterm.js: background, foreground, cursor, black…brightWhite). */
  term: Record<string, string>;
  updatedAt?: number;
}

/** Permisos que un plugin puede pedir (además de comandos, avisos, temas y almacenamiento propio). */
export type PluginPermission = 'terminal:read' | 'terminal:write' | 'sessions:read';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Archivo JavaScript principal (por defecto main.js). */
  main?: string;
  permissions?: PluginPermission[];
}

export interface PluginInfo {
  id: string;
  dir: string;
  manifest?: PluginManifest;
  /** Error al leer el manifiesto. */
  error?: string;
  enabled: boolean;
  /** Activado, pero pide permisos que el usuario aún no ha aceptado (p. ej. tras actualizarlo). */
  needsApproval: boolean;
}
