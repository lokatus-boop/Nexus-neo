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

  // RDP / VNC (cliente externo en el MVP)
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
