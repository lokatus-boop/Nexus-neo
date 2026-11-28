// Conexión SSH: shell interactivo, SFTP, túneles, X11 y salto por bastión (ProxyJump).
import { Client, ClientChannel, ConnectConfig, SFTPWrapper, utils } from 'ssh2';
import { createHash } from 'node:crypto';
import { fakeCookie, localXCookie, parseDisplay, proxyX11Channel, resolveLocalDisplay } from '../x11';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TerminalConnection, Prompter } from './base';
import { TunnelManager } from './tunnels';
import type { SecretEntry, SessionConfig } from '../../shared/types';

export interface KnownHosts {
  get(hostPort: string): string | undefined;
  set(hostPort: string, fingerprint: string): Promise<void>;
}

export interface SshDeps {
  prompter: Prompter;
  knownHosts: KnownHosts;
  /** Secretos guardados para la sesión (si la bóveda está desbloqueada). */
  secretFor(sessionId: string): SecretEntry | undefined;
  /** Resuelve una sesión por id (para bastiones). */
  sessionById(id: string): SessionConfig | undefined;
  /** Notifica cambios en los túneles. */
  onTunnelsChanged(): void;
}

export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function defaultKeyPaths(): string[] {
  const dir = join(homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => join(dir, f)).filter((p) => existsSync(p));
}

function agentSocket(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return undefined;
}

function keyNeedsPassphrase(data: Buffer): boolean {
  const parsed = utils.parseKey(data);
  return parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message);
}

/** Abre un cliente ssh2 autenticado, encadenando bastiones si hace falta. */
export async function connectClient(cfg: SessionConfig, deps: SshDeps, depth = 0, sock?: NodeJS.ReadableStream): Promise<Client> {
  if (depth > 5) throw new Error('Demasiados saltos encadenados.');
  let jump: Client | undefined;
  if (cfg.jumpSessionId && !sock) {
    const jumpCfg = deps.sessionById(cfg.jumpSessionId);
    if (!jumpCfg) throw new Error('La sesión de salto no existe.');
    jump = await connectClient(jumpCfg, deps, depth + 1);
    sock = await new Promise<ClientChannel>((resolve, reject) =>
      jump!.forwardOut('127.0.0.1', 0, cfg.host!, cfg.port || 22, (err, ch) => (err ? reject(err) : resolve(ch))),
    );
  }

  const client = new Client();
  const host = cfg.host || 'localhost';
  const port = cfg.port || 22;
  const username = cfg.username || process.env.USER || process.env.USERNAME || 'root';
  const secret = deps.secretFor(cfg.id) || {};

  // Lista de métodos a intentar, en orden.
  type Method = () => Promise<Record<string, unknown> | null>;
  const methods: Method[] = [];
  const keyFiles = cfg.auth === 'key' ? (cfg.keyPath ? [cfg.keyPath] : defaultKeyPaths()) : [];
  for (const kp of keyFiles) {
    methods.push(async () => {
      const key = readFileSync(kp);
      let passphrase = secret.passphrase;
      if (keyNeedsPassphrase(key) && !passphrase) {
        const ans = await deps.prompter.auth({
          title: `Frase de paso para ${kp}`,
          prompts: [{ prompt: 'Frase de paso:', echo: false }],
        });
        if (!ans) return null;
        passphrase = ans[0];
      }
      return { type: 'publickey', username, key, passphrase };
    });
  }
  if (cfg.auth === 'agent' || cfg.auth === 'key') {
    const agent = agentSocket();
    if (agent) methods.push(async () => ({ type: 'agent', username, agent }));
  }
  if (cfg.auth === 'password' || !cfg.auth) {
    methods.push(async () => {
      let password = secret.password;
      if (!password) {
        const ans = await deps.prompter.auth({
          title: `Contraseña para ${username}@${host}`,
          prompts: [{ prompt: 'Contraseña:', echo: false }],
        });
        if (!ans) return null;
        password = ans[0];
      }
      return { type: 'password', username, password };
    });
  }
  methods.push(async () => ({
    type: 'keyboard-interactive',
    username,
    prompt: (name: string, instructions: string, _lang: string, prompts: { prompt: string; echo: boolean }[], finish: (r: string[]) => void) => {
      if (prompts.length === 0) return finish([]);
      // Si sólo pide la contraseña y la tenemos guardada, la usamos.
      if (prompts.length === 1 && /password|contraseña/i.test(prompts[0].prompt) && secret.password) return finish([secret.password]);
      deps.prompter
        .auth({ title: name || `Autenticación ${username}@${host}`, instructions, prompts })
        .then((ans) => finish(ans || []));
    },
  }));
  let idx = 0;

  const connectCfg: ConnectConfig = {
    host,
    port,
    username,
    sock: sock as ConnectConfig['sock'],
    readyTimeout: 30000,
    keepaliveInterval: (cfg.keepAliveSec ?? 30) * 1000,
    keepaliveCountMax: 4,
    tryKeyboard: true,
    hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
      const fp = fingerprintOf(key);
      const id = `[${host}]:${port}`;
      const known = deps.knownHosts.get(id);
      if (known === fp) return verify(true);
      const parsed = utils.parseKey(key);
      const algorithm = parsed instanceof Error ? 'desconocido' : (Array.isArray(parsed) ? parsed[0] : parsed).type;
      deps.prompter
        .hostKey({ host, port, fingerprint: fp, algorithm, previous: known })
        .then(async (ok) => {
          if (ok) await deps.knownHosts.set(id, fp);
          verify(ok);
        })
        .catch(() => verify(false));
    }) as unknown as ConnectConfig['hostVerifier'],
    authHandler: ((_left: string[] | null, _partial: boolean | null, next: (m: unknown) => void) => {
      const tryNext = (): void => {
        if (idx >= methods.length) return next(false);
        const m = methods[idx++];
        m()
          .then((res) => (res ? next(res) : tryNext()))
          .catch(() => tryNext());
      };
      tryNext();
    }) as unknown as ConnectConfig['authHandler'],
  };

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (e) => reject(e));
    client.connect(connectCfg);
  });
  if (jump) client.once('close', () => jump!.end());
  return client;
}

export { parseDisplay } from '../x11';

export class SshConnection extends TerminalConnection {
  client: Client | null = null;
  private stream: ClientChannel | null = null;
  private sftpP: Promise<SFTPWrapper> | null = null;
  tunnels: TunnelManager | null = null;

  constructor(readonly cfg: SessionConfig, private readonly deps: SshDeps, readonly connId: string) {
    super();
  }

  async open(cols: number, rows: number): Promise<void> {
    this.emitData(`\x1b[90mConectando a ${this.cfg.username ? this.cfg.username + '@' : ''}${this.cfg.host}:${this.cfg.port || 22}…\x1b[0m\r\n`);
    const client = await connectClient(this.cfg, this.deps);
    this.client = client;
    client.on('close', () => {
      this.setState('closed');
      this.emit('exit');
    });
    client.on('error', (e) => this.setState('error', e.message));

    this.tunnels = new TunnelManager(client, this.connId, this.deps.onTunnelsChanged);
    this.tunnels.configure(this.cfg.tunnels || []);
    void this.tunnels.startAuto();

    const x11 = this.cfg.x11 !== false ? this.setupX11(client) : null;
    try {
      this.stream = await this.openShell(client, cols, rows, x11);
    } catch (e) {
      if (!x11) throw e;
      // El servidor rechazó el reenvío X11 (X11Forwarding no, falta xauth…): abrimos el shell sin él.
      this.emitData(
        `\x1b[33m[X11] El servidor no ha aceptado el reenvío X11 (${(e as Error).message}). ` +
          'Revisa «X11Forwarding yes» en /etc/ssh/sshd_config y que el paquete xauth esté instalado en el servidor.\x1b[0m\r\n',
      );
      this.stream = await this.openShell(client, cols, rows, null);
    }
    this.stream.on('data', (d: Buffer) => this.emitData(d));
    this.stream.stderr.on('data', (d: Buffer) => this.emitData(d));
    this.stream.on('close', () => client.end());
    this.setState('connected');
  }

  /** Prepara el reenvío X11: cookie falsa para el remoto y proxy hacia el servidor X local. */
  private setupX11(client: Client): { protocol: string; cookie: string; screen: number } {
    const { display } = resolveLocalDisplay(this.cfg.x11Display);
    const target = parseDisplay(display);
    const real = localXCookie(target);
    const fake = fakeCookie();
    let warned = false;
    client.on('x11', (_info, accept) => {
      proxyX11Channel(accept(), target, fake, real, (msg, kind) => {
        if (kind === 'auth') {
          this.emitData(`\r\n\x1b[33m[X11] Conexión X11 rechazada: ${msg}.\x1b[0m\r\n`);
          return;
        }
        if (warned) return;
        warned = true;
        const hint =
          process.platform === 'win32'
            ? 'Inicia un servidor X en Windows (VcXsrv con «Disable access control», X410…) o indica su DISPLAY en la sesión.'
            : 'Comprueba que hay una sesión gráfica (DISPLAY/XWayland) o indica la pantalla en la sesión.';
        this.emitData(`\r\n\x1b[33m[X11] No se pudo conectar con el servidor X local ${display} (${msg}). ${hint}\x1b[0m\r\n`);
      });
    });
    return { protocol: fake.protocol, cookie: fake.cookie.toString('hex'), screen: target.screen };
  }

  private openShell(client: Client, cols: number, rows: number, x11: { protocol: string; cookie: string; screen: number } | null): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      const opts = x11 ? { x11 } : {};
      (client.shell as (w: unknown, o: unknown, cb: (err: Error | undefined, ch: ClientChannel) => void) => void).call(
        client,
        { term: this.cfg.term || 'xterm-256color', cols, rows },
        opts,
        (err, ch) => (err ? reject(err) : resolve(ch)),
      );
    });
  }

  sftp(): Promise<SFTPWrapper> {
    if (!this.client) return Promise.reject(new Error('No conectado'));
    if (!this.sftpP) {
      this.sftpP = new Promise((resolve, reject) =>
        this.client!.sftp((err, s) => {
          if (err) {
            this.sftpP = null;
            return reject(err);
          }
          s.on('close', () => (this.sftpP = null));
          resolve(s);
        }),
      );
    }
    return this.sftpP;
  }

  /** Ejecuta un comando no interactivo y devuelve su salida (para monitorización). */
  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('No conectado'));
      this.client.exec(command, (err, ch) => {
        if (err) return reject(err);
        let out = '';
        ch.on('data', (d: Buffer) => (out += d.toString('utf8')));
        ch.stderr.on('data', () => undefined);
        ch.on('close', () => resolve(out));
      });
    });
  }

  write(data: string): void {
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    void this.tunnels?.stopAll();
    this.stream?.close();
    this.client?.end();
    this.client = null;
  }
}
