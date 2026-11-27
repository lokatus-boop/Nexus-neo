// Códec Telnet mínimo (RFC 854) con negociación de ECHO, SGA, NAWS y TTYPE.
// Es puro (sin E/S) para poder probarlo de forma aislada.

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_TTYPE = 24;
export const OPT_NAWS = 31;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

type State = 'data' | 'iac' | 'cmd' | 'sb' | 'sb-iac';

export interface TelnetOutput {
  /** Datos de aplicación para mostrar en el terminal. */
  data: Buffer;
  /** Respuestas de negociación a enviar al servidor. */
  reply: Buffer;
}

export class TelnetCodec {
  private state: State = 'data';
  private cmd = 0;
  private sbBuf: number[] = [];
  private nawsEnabled = false;
  cols = 80;
  rows = 24;

  constructor(private readonly termType = 'xterm-256color') {}

  /** Procesa bytes recibidos del servidor. */
  decode(chunk: Buffer): TelnetOutput {
    const data: number[] = [];
    const reply: number[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else data.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            data.push(IAC);
            this.state = 'data';
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = 'cmd';
          } else if (b === SB) {
            this.sbBuf = [];
            this.state = 'sb';
          } else {
            // NOP, GA, etc. Se ignoran.
            this.state = 'data';
          }
          break;
        case 'cmd':
          reply.push(...this.negotiate(this.cmd, b));
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb-iac';
          else this.sbBuf.push(b);
          break;
        case 'sb-iac':
          if (b === SE) {
            reply.push(...this.subnegotiation(this.sbBuf));
            this.state = 'data';
          } else {
            if (b === IAC) this.sbBuf.push(IAC);
            this.state = 'sb';
          }
          break;
      }
    }
    return { data: Buffer.from(data), reply: Buffer.from(reply) };
  }

  /** Escapa datos del usuario antes de enviarlos (duplica IAC). */
  encode(input: Buffer): Buffer {
    if (!input.includes(IAC)) return input;
    const out: number[] = [];
    for (const b of input) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    return Buffer.from(out);
  }

  /** Mensaje NAWS con el tamaño actual (vacío si el servidor no lo pidió). */
  resize(cols: number, rows: number): Buffer {
    this.cols = cols;
    this.rows = rows;
    return this.nawsEnabled ? this.nawsMessage() : Buffer.alloc(0);
  }

  private nawsMessage(): Buffer {
    const bytes = [this.cols >> 8, this.cols & 0xff, this.rows >> 8, this.rows & 0xff];
    const escaped: number[] = [];
    for (const b of bytes) {
      escaped.push(b);
      if (b === IAC) escaped.push(IAC);
    }
    return Buffer.from([IAC, SB, OPT_NAWS, ...escaped, IAC, SE]);
  }

  private negotiate(cmd: number, opt: number): number[] {
    if (cmd === DO) {
      if (opt === OPT_NAWS) {
        this.nawsEnabled = true;
        return [IAC, WILL, OPT_NAWS, ...this.nawsMessage()];
      }
      if (opt === OPT_TTYPE) return [IAC, WILL, OPT_TTYPE];
      if (opt === OPT_SGA) return [IAC, WILL, OPT_SGA];
      return [IAC, WONT, opt];
    }
    if (cmd === WILL) {
      if (opt === OPT_ECHO || opt === OPT_SGA) return [IAC, DO, opt];
      return [IAC, DONT, opt];
    }
    if (cmd === DONT) {
      if (opt === OPT_NAWS) this.nawsEnabled = false;
      return [IAC, WONT, opt];
    }
    // WONT: aceptamos sin respuesta.
    return [];
  }

  private subnegotiation(buf: number[]): number[] {
    if (buf[0] === OPT_TTYPE && buf[1] === TTYPE_SEND) {
      return [IAC, SB, OPT_TTYPE, TTYPE_IS, ...Buffer.from(this.termType, 'ascii'), IAC, SE];
    }
    return [];
  }
}
