// Registro de sesiones a archivo (una carpeta por día, un archivo por conexión).
import { createWriteStream, WriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Secuencias CSI/OSC/ESC habituales de los terminales.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');
}

export function logFileName(sessionName: string, when = new Date()): { day: string; file: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const safe = sessionName.replace(/[^\w.@-]+/g, '_').slice(0, 60) || 'sesion';
  return { day, file: `${safe}_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}.log` };
}

export class SessionLogger {
  private stream: WriteStream;
  readonly path: string;

  constructor(dir: string, sessionName: string, private readonly strip: boolean) {
    const { day, file } = logFileName(sessionName);
    mkdirSync(join(dir, day), { recursive: true });
    this.path = join(dir, day, file);
    this.stream = createWriteStream(this.path, { flags: 'a', mode: 0o600 });
    this.stream.on('error', () => undefined);
    this.stream.write(`# Nexus Neo · ${sessionName} · ${new Date().toISOString()}\n`);
  }

  write(data: string): void {
    this.stream.write(this.strip ? stripAnsi(data) : data);
  }

  close(): void {
    this.stream.end(`\n# Fin de sesión · ${new Date().toISOString()}\n`);
  }
}
