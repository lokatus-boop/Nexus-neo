import { existsSync, readdirSync } from 'node:fs';
import { TerminalConnection } from './base';
import type { SessionConfig } from '../../shared/types';

// serialport es un módulo nativo: se carga bajo demanda para que la app
// arranque aunque falte el binario en alguna plataforma.
type SerialPortCtor = typeof import('serialport').SerialPort;
let SerialPortImpl: SerialPortCtor | null = null;
function loadSerial(): SerialPortCtor {
  if (!SerialPortImpl) SerialPortImpl = (require('serialport') as typeof import('serialport')).SerialPort;
  return SerialPortImpl;
}

function hasUdevadm(): boolean {
  return ['/usr/bin/udevadm', '/bin/udevadm', '/sbin/udevadm', '/usr/sbin/udevadm'].some((p) => existsSync(p));
}

/** Alternativa en Linux sin udev (contenedores, WSL): lista los dispositivos de /dev. */
function listDevTty(): { path: string; label: string }[] {
  try {
    return readdirSync('/dev')
      .filter((n) => /^tty(USB|ACM|S|AMA)\d+$/.test(n))
      .map((n) => ({ path: `/dev/${n}`, label: `/dev/${n}` }));
  } catch {
    return [];
  }
}

export async function listSerialPorts(): Promise<{ path: string; label: string }[]> {
  // En Linux, serialport depende de udevadm y su ausencia provoca un error no capturable.
  if (process.platform === 'linux' && !hasUdevadm()) return listDevTty();
  try {
    const ports = await loadSerial().list();
    return ports.map((p) => ({
      path: p.path,
      label: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(' · '),
    }));
  } catch {
    return [];
  }
}

export class SerialConnection extends TerminalConnection {
  private port: InstanceType<SerialPortCtor> | null = null;

  constructor(private readonly cfg: SessionConfig) {
    super();
  }

  open(): Promise<void> {
    const SerialPort = loadSerial();
    if (!this.cfg.serialPath) return Promise.reject(new Error('No se ha indicado el puerto serie.'));
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.cfg.serialPath!,
          baudRate: this.cfg.baudRate || 115200,
          dataBits: this.cfg.dataBits || 8,
          stopBits: this.cfg.stopBits || 1,
          parity: this.cfg.parity || 'none',
          autoOpen: false,
        },
      );
      this.port = port;
      port.open((err) => {
        if (err) return reject(err);
        this.setState('connected');
        resolve();
      });
      port.on('data', (chunk: Buffer) => this.emitData(chunk));
      port.on('error', (e: Error) => this.setState('error', e.message));
      port.on('close', () => {
        this.setState('closed');
        this.emit('exit');
      });
    });
  }

  write(data: string): void {
    if (this.cfg.localEcho) this.emitData(data.replace(/\r/g, '\r\n'));
    this.port?.write(data);
  }

  resize(): void {
    /* Los puertos serie no tienen tamaño de ventana. */
  }

  close(): void {
    if (this.port?.isOpen) this.port.close();
    this.port = null;
  }
}
