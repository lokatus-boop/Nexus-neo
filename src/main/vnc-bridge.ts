// Puente entre el visor VNC integrado (noVNC en una ventana propia) y el servidor RFB.
// Conecta por TCP directamente o a través de una sesión SSH (túnel automático).
import { connect, Socket } from 'node:net';
import type { Client, ClientChannel } from 'ssh2';
import type { Duplex } from 'node:stream';

export interface VncTarget {
  host: string;
  port: number;
  /** Cliente SSH ya autenticado para tunelizar (opcional). */
  ssh?: Client;
}

export class VncBridge {
  private stream: Duplex | null = null;
  private closed = false;

  constructor(
    private readonly target: VncTarget,
    private readonly onData: (chunk: Uint8Array) => void,
    private readonly onClose: (reason?: string) => void,
  ) {}

  async open(): Promise<void> {
    const { host, port, ssh } = this.target;
    let s: Duplex;
    if (ssh) {
      s = await new Promise<ClientChannel>((resolve, reject) =>
        ssh.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))));
    } else {
      s = await new Promise<Socket>((resolve, reject) => {
        const sock = connect({ host, port });
        sock.setNoDelay(true);
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
      });
    }
    this.stream = s;
    s.on('data', (d: Buffer) => this.onData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    s.on('error', (e: Error) => this.finish(e.message));
    s.on('close', () => this.finish());
    s.on('end', () => this.finish());
  }

  write(data: Uint8Array): void {
    this.stream?.write(Buffer.from(data));
  }

  close(): void {
    this.stream?.destroy();
    this.finish();
  }

  private finish(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
    if (this.target.ssh) this.target.ssh.end();
  }
}
