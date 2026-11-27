// Sesión de línea de órdenes «desatendida» contra equipos de red (switches, routers, AP,
// cortafuegos) por SSH o Telnet: inicia sesión, detecta el prompt, pasa a modo privilegiado
// (enable), envía órdenes una a una, salta los paginadores (--More--) y recoge la salida.
import { connect as netConnect, Socket } from 'node:net';
import type { Client, ClientChannel } from 'ssh2';
import { TelnetCodec } from '../protocols/telnet-codec';

/** Prompt típico: «sw-core#», «sw1>», «[admin@MikroTik] >», «user@host:~$», «FGT (global) #». */
export const DEFAULT_PROMPT = String.raw`(?:^|\n)[^\n]{0,80}?[>#$%\]]\s?$`;
const PAGERS = /(--\s?More\s?--|<--- More --->|Press any key to continue|-- More --|\(more\)|--more--)\s*$/i;
/** Preguntas interactivas: «[confirm]», «(y/n)», «Destination filename [x]?». */
export const QUESTION = /(\[confirm\]|\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]|\]\?|\? ?\[[^\]\n]*\])\s*$/i;
const LOGIN_RE = /(user ?name|login|usuario)\s*:\s*$/i;
const PASSWORD_RE = /(password|contraseña)\s*:\s*$/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]/g;

export interface CliOptions {
  /** Expresión regular del prompt (se evalúa sobre el final de la salida). */
  prompt?: string;
  /** Contraseña de enable (si el prompt termina en «>» y se indica, se entra en modo privilegiado). */
  enablePassword?: string;
  /** Tiempo máximo de espera por orden (ms). */
  timeoutMs?: number;
  /** Fin de línea a enviar tras cada orden. */
  newline?: '\r' | '\n' | '\r\n';
}

export interface CliStream {
  write(data: string): void;
  onData(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

export function cleanOutput(s: string): string {
  return s.replace(ANSI, '').replace(/\r+\n/g, '\n').replace(/\r/g, '').replace(/[\x08]/g, '');
}

export class CliSession {
  private buf = '';
  private waiters: (() => void)[] = [];
  private closed = false;
  readonly transcript: string[] = [];
  private readonly prompt: RegExp;
  private readonly timeout: number;
  private readonly nl: string;

  constructor(private readonly stream: CliStream, private readonly opts: CliOptions = {}) {
    this.prompt = new RegExp(opts.prompt || DEFAULT_PROMPT);
    this.timeout = opts.timeoutMs ?? 30_000;
    this.nl = opts.newline ?? '\r';
    stream.onData((t) => {
      const clean = cleanOutput(t);
      this.buf += clean;
      this.transcript.push(clean);
      for (const w of this.waiters.splice(0)) w();
    });
    stream.onClose(() => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Espera a que la salida acumulada cumpla una condición y, además, a que el equipo deje de
   * enviar datos un instante (así una línea de salida que acabe en «#» o «>» no se confunde
   * con el prompt). Devuelve y consume lo recibido.
   */
  private wait(match: (buf: string) => boolean, timeoutMs = this.timeout, settleMs = 150): Promise<string> {
    return new Promise((resolve, reject) => {
      let settle: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s). Última salida: ${JSON.stringify(this.buf.slice(-120))}`));
      }, timeoutMs);
      const take = () => {
        cleanup();
        const out = this.buf;
        this.buf = '';
        resolve(out);
      };
      const check = () => {
        if (settle) clearTimeout(settle);
        settle = null;
        // Si el equipo cierra la sesión (p. ej. tras «exit» o «reload»), se devuelve lo recibido.
        if (this.closed) return take();
        if (match(this.buf)) settle = setTimeout(() => match(this.buf) && take(), settleMs);
        this.waiters.push(check);
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        const i = this.waiters.indexOf(check);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      check();
    });
  }

  private tail(buf: string): string {
    return buf.slice(-300);
  }

  private atPrompt = (buf: string) => this.prompt.test(this.tail(buf));

  /** Espera el primer prompt; en Telnet responde a «Username:/Password:» si se dan credenciales. */
  async login(creds?: { username?: string; password?: string }): Promise<string> {
    let out = '';
    let sentPassword = false;
    let ready = false;
    for (let i = 0; i < 8; i++) {
      const chunk = await this.wait((b) => this.atPrompt(b) || LOGIN_RE.test(this.tail(b)) || PASSWORD_RE.test(this.tail(b)) || PAGERS.test(this.tail(b)));
      out += chunk;
      const t = this.tail(chunk);
      if (PAGERS.test(t)) this.stream.write(' ');
      else if (LOGIN_RE.test(t) || PASSWORD_RE.test(t)) {
        // Si vuelve a pedir credenciales después de dar la contraseña, eran incorrectas.
        if (sentPassword) throw new Error('Usuario o contraseña incorrectos.');
        if (LOGIN_RE.test(t)) {
          if (!creds?.username) throw new Error('El equipo pide usuario y no se ha indicado ninguno.');
          this.stream.write(creds.username + this.nl);
        } else {
          if (creds?.password === undefined) throw new Error('El equipo pide contraseña y no se ha indicado ninguna.');
          this.stream.write(creds.password + this.nl);
          sentPassword = true;
        }
      } else if (this.atPrompt(chunk)) {
        ready = true;
        break;
      }
      if (this.closed) throw new Error('El equipo cerró la conexión durante el inicio de sesión.');
    }
    if (!ready) throw new Error('No se ha reconocido el prompt del equipo tras iniciar sesión. Indica la expresión del prompt en las opciones.');
    if (this.opts.enablePassword !== undefined && /> ?$/.test(out.trimEnd())) {
      this.stream.write('enable' + this.nl);
      const r = await this.wait((b) => PASSWORD_RE.test(this.tail(b)) || this.atPrompt(b));
      out += r;
      if (PASSWORD_RE.test(this.tail(r))) {
        this.stream.write(this.opts.enablePassword + this.nl);
        out += await this.wait((b) => this.atPrompt(b) || PASSWORD_RE.test(this.tail(b)));
        if (PASSWORD_RE.test(this.tail(out))) throw new Error('Contraseña de enable incorrecta.');
      }
    }
    return out;
  }

  /** Envía una orden y devuelve su salida (sin el eco de la orden ni el prompt final). */
  async run(command: string, timeoutMs?: number): Promise<string> {
    if (this.closed) throw new Error('La sesión está cerrada.');
    this.stream.write(command + this.nl);
    let out = '';
    for (;;) {
      const chunk = await this.wait((b) => this.atPrompt(b) || PAGERS.test(this.tail(b)) || QUESTION.test(this.tail(b)), timeoutMs);
      if (PAGERS.test(this.tail(chunk))) {
        out += chunk.replace(PAGERS, '');
        this.stream.write(' ');
        continue;
      }
      out += chunk;
      break;
    }
    const lines = out.split('\n');
    // Quita el eco de la orden (primera línea) y el prompt (última).
    if (lines.length && lines[0].trim().endsWith(command.trim())) lines.shift();
    if (lines.length && this.atPrompt(lines[lines.length - 1])) lines.pop();
    return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/^\n+|\n+$/g, '');
  }

  /** Responde a una pregunta de confirmación pendiente (p. ej. «[confirm]»). */
  send(text: string): void {
    this.stream.write(text);
  }

  close(): void {
    this.stream.close();
  }
}

// --- Transportes ---------------------------------------------------------------

export function sshStream(client: Client): Promise<CliStream> {
  return new Promise((resolve, reject) => {
    // Terminal «tonto» y muy alto para que los equipos paginen lo menos posible.
    client.shell({ term: 'vt100', cols: 200, rows: 1000 }, (err, ch: ClientChannel) => {
      if (err) return reject(err);
      resolve({
        write: (d) => ch.write(d),
        onData: (fn) => {
          ch.on('data', (b: Buffer) => fn(b.toString('utf8')));
          ch.stderr.on('data', (b: Buffer) => fn(b.toString('utf8')));
        },
        onClose: (fn) => ch.on('close', fn),
        close: () => {
          ch.close();
          client.end();
        },
      });
    });
  });
}

export function telnetStream(host: string, port: number, timeoutMs = 15000): Promise<CliStream> {
  return new Promise((resolve, reject) => {
    const codec = new TelnetCodec('vt100');
    codec.cols = 200;
    codec.rows = 1000;
    const sock: Socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Sin respuesta de ${host}:${port}`));
    }, timeoutMs);
    const listeners: ((t: string) => void)[] = [];
    const early: string[] = [];
    sock.on('data', (chunk: Buffer) => {
      const { data, reply } = codec.decode(chunk);
      if (reply.length) sock.write(reply);
      if (!data.length) return;
      if (listeners.length) for (const l of listeners) l(data.toString('utf8'));
      else early.push(data.toString('utf8'));
    });
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve({
        write: (d) => sock.write(codec.encode(Buffer.from(d, 'utf8'))),
        onData: (fn) => {
          listeners.push(fn);
          for (const t of early.splice(0)) fn(t);
        },
        onClose: (fn) => sock.on('close', fn),
        close: () => sock.destroy(),
      });
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
