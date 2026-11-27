import { Socket, connect } from 'node:net';
import { TerminalConnection } from './base';
import { TelnetCodec } from './telnet-codec';
import type { SessionConfig } from '../../shared/types';

export class TelnetConnection extends TerminalConnection {
  private socket: Socket | null = null;
  private codec: TelnetCodec;

  constructor(private readonly cfg: SessionConfig) {
    super();
    this.codec = new TelnetCodec(cfg.term || 'xterm-256color');
  }

  open(cols: number, rows: number): Promise<void> {
    this.codec.cols = cols;
    this.codec.rows = rows;
    const host = this.cfg.host || 'localhost';
    const port = this.cfg.port || 23;
    return new Promise((resolve, reject) => {
      const sock = connect({ host, port });
      this.socket = sock;
      let settled = false;
      sock.setNoDelay(true);
      sock.once('connect', () => {
        settled = true;
        this.setState('connected');
        resolve();
      });
      sock.on('data', (chunk: Buffer) => {
        const { data, reply } = this.codec.decode(chunk);
        if (reply.length) sock.write(reply);
        if (data.length) this.emitData(data);
      });
      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.setState('error', err.message);
      });
      sock.on('close', () => {
        this.setState('closed');
        this.emit('exit');
      });
    });
  }

  write(data: string): void {
    this.socket?.write(this.codec.encode(Buffer.from(data, 'utf8')));
  }

  resize(cols: number, rows: number): void {
    const msg = this.codec.resize(cols, rows);
    if (msg.length) this.socket?.write(msg);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
