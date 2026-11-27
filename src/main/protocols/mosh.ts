// Sesión Mosh: se entra por SSH (con la misma autenticación, bastiones y bóveda que una sesión
// SSH), se arranca «mosh-server new» y, con el puerto y la clave que devuelve, se habla por UDP.
// La conexión aguanta cambios de red (wifi ↔ cable ↔ móvil), suspensiones y cortes largos.
import { TerminalConnection } from './base';
import { connectClient, SshDeps } from './ssh';
import { MoshTransport, parseMoshConnect } from './mosh/transport';
import type { SessionConfig } from '../../shared/types';
import type { Client } from 'ssh2';

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Comando remoto que arranca el servidor Mosh. */
export function moshServerCommand(cfg: SessionConfig): string {
  const parts = [shq(cfg.moshServer?.trim() || 'mosh-server'), 'new', '-s', '-c', '256', '-l', `LANG=${cfg.moshLocale?.trim() || 'C.UTF-8'}`];
  if (cfg.moshPorts?.trim()) parts.push('-p', shq(cfg.moshPorts.trim()));
  if (cfg.moshCommand?.trim()) parts.push('--', cfg.moshCommand.trim());
  return parts.join(' ');
}

function execOutput(client: Client, command: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (err, ch) => {
      if (err) return reject(err);
      let out = '';
      let code: number | null = null;
      ch.on('data', (d: Buffer) => (out += d.toString('utf8')));
      ch.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
      ch.on('exit', (c: number | null) => (code = c));
      ch.on('close', () => resolve({ out, code }));
    });
  });
}

export class MoshConnection extends TerminalConnection {
  private transport: MoshTransport | null = null;
  private size = { cols: 80, rows: 24 };
  private lastSilence = 0;

  constructor(readonly cfg: SessionConfig, private readonly deps: SshDeps) {
    super();
  }

  async open(cols: number, rows: number): Promise<void> {
    this.size = { cols, rows };
    const host = this.cfg.moshHost?.trim() || this.cfg.host || 'localhost';
    this.emitData(`\x1b[90mMosh: iniciando sesión SSH en ${this.cfg.username ? this.cfg.username + '@' : ''}${this.cfg.host}:${this.cfg.port || 22}…\x1b[0m\r\n`);
    const client = await connectClient(this.cfg, this.deps);
    let result: { out: string; code: number | null };
    try {
      result = await execOutput(client, moshServerCommand(this.cfg));
    } finally {
      client.end();
    }
    const conn = parseMoshConnect(result.out);
    if (!conn) {
      const out = result.out.trim();
      if (result.code === 127 || /not found|no se encontró|No such file/i.test(out)) {
        throw new Error('mosh-server no está instalado en el servidor (p. ej. «sudo apt install mosh» o «sudo dnf install mosh»).');
      }
      throw new Error(`mosh-server no arrancó${out ? `: ${out.split('\n').slice(-3).join(' ')}` : ''}`);
    }
    this.emitData(`\x1b[90mMosh: conectando por UDP a ${host}:${conn.port}…\x1b[0m\r\n`);

    const t = new MoshTransport({ host, port: conn.port, key: conn.key });
    this.transport = t;
    let first = true;
    t.on('host', (d: Buffer) => {
      if (first) {
        // La pantalla de Mosh parte de un terminal vacío: se limpia lo escrito antes.
        first = false;
        this.emitData('\x1bc');
        this.setState('connected');
      }
      this.emitData(d);
    });
    t.on('heard', (silentMs: number) => {
      const s = Math.floor(silentMs / 1000);
      if (s === this.lastSilence || this.state === 'closed') return;
      this.lastSilence = s;
      if (this.state === 'connected') this.emit('state', 'connected', s ? `Sin respuesta del servidor desde hace ${s} s (Mosh reconectará solo)` : undefined);
    });
    t.on('closed', () => {
      this.transport = null;
      this.setState('closed', 'La sesión Mosh terminó');
      this.emit('exit');
    });
    t.on('error', (e: Error) => this.emitData(`\r\n\x1b[33m⚠ Mosh: ${e.message}\x1b[0m\r\n`));
    t.start();
    t.resize(this.size.cols, this.size.rows);
    // Si en 15 s no llega nada, el UDP está bloqueado por un cortafuegos.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        t.close();
        reject(new Error(`No llega respuesta UDP de ${host}:${conn.port}. Abre los puertos UDP de Mosh (60000-61000) en el cortafuegos o configura un rango en la sesión.`));
      }, 15000);
      t.once('host', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  write(data: string): void {
    this.transport?.sendKeys(Buffer.from(data, 'utf8'));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.transport?.resize(cols, rows);
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
  }
}
