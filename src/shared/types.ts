// Tipos compartidos entre el proceso principal, el preload y la interfaz.

export type SessionKind = 'ssh' | 'local' | 'telnet' | 'serial' | 'rdp' | 'vnc';

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
  x11?: boolean;
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
// Servidores integrados (TFTP, FTP, HTTP, Syslog)

export type ServerKind = 'tftp' | 'ftp' | 'http' | 'syslog';

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
}

export interface ServerStatus {
  id: string;
  running: boolean;
  error?: string;
  /** Transferencias/conexiones activas. */
  active: number;
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
