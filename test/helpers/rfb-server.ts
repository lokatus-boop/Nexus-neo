// Servidor RFB (VNC) mínimo para pruebas: protocolo 3.8, sin autenticación,
// codificación Raw. Pinta la mitad izquierda en rojo y la derecha en azul.
import { createServer, AddressInfo, Server, Socket } from 'node:net';

export interface FakeVnc {
  port: number;
  keys: number[];
  pointerEvents: number;
  close(): Promise<void>;
}

export async function startFakeVnc(width = 320, height = 200, name = 'Escritorio de pruebas'): Promise<FakeVnc> {
  const state: FakeVnc = { port: 0, keys: [], pointerEvents: 0, close: async () => undefined };
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let stage: 'version' | 'security' | 'init' | 'normal' = 'version';
    let fmt = { bpp: 32, big: false, rs: 16, gs: 8, bs: 0 };
    let sentFull = false;
    sock.write('RFB 003.008\n');

    const frame = () => {
      const bytes = fmt.bpp / 8;
      const px = Buffer.alloc(width * height * bytes);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b] = x < width / 2 ? [255, 0, 0] : [0, 0, 255];
          const v = ((r << fmt.rs) | (g << fmt.gs) | (b << fmt.bs)) >>> 0;
          const off = (y * width + x) * bytes;
          if (fmt.big) px.writeUInt32BE(v, off);
          else px.writeUInt32LE(v, off);
        }
      }
      const head = Buffer.alloc(16);
      head.writeUInt8(0, 0); // FramebufferUpdate
      head.writeUInt16BE(1, 2);
      head.writeUInt16BE(0, 4);
      head.writeUInt16BE(0, 6);
      head.writeUInt16BE(width, 8);
      head.writeUInt16BE(height, 10);
      head.writeInt32BE(0, 12); // Raw
      sock.write(Buffer.concat([head, px]));
    };

    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 1])); // 1 tipo de seguridad: None
          stage = 'security';
        } else if (stage === 'security') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
          stage = 'init';
        } else if (stage === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const n = Buffer.from(name, 'utf8');
          const si = Buffer.alloc(24);
          si.writeUInt16BE(width, 0);
          si.writeUInt16BE(height, 2);
          // Formato de píxel por defecto: 32 bpp, profundidad 24, little endian, true color.
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(si, 4);
          si.writeUInt32BE(n.length, 20);
          sock.write(Buffer.concat([si, n]));
          stage = 'normal';
        } else {
          if (buf.length < 1) return;
          const t = buf[0];
          let len = 0;
          if (t === 0) len = 20;
          else if (t === 2) {
            if (buf.length < 4) return;
            len = 4 + buf.readUInt16BE(2) * 4;
          } else if (t === 3) len = 10;
          else if (t === 4) len = 8;
          else if (t === 5) len = 6;
          else if (t === 6) {
            if (buf.length < 8) return;
            len = 8 + Math.abs(buf.readInt32BE(4));
          } else {
            buf = Buffer.alloc(0);
            return;
          }
          if (buf.length < len) return;
          const msg = buf.subarray(0, len);
          buf = buf.subarray(len);
          if (t === 0) {
            fmt = { bpp: msg[4], big: msg[6] === 1, rs: msg[14], gs: msg[15], bs: msg[16] };
          } else if (t === 3) {
            const incremental = msg[1] === 1;
            if (!incremental || !sentFull) {
              sentFull = true;
              frame();
            }
          } else if (t === 4) {
            if (msg[1] === 1) state.keys.push(msg.readUInt32BE(4));
          } else if (t === 5) state.pointerEvents++;
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}
