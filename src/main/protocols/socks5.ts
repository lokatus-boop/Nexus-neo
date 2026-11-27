// Servidor SOCKS5 mínimo (sin autenticación, sólo CONNECT) para túneles dinámicos.
import type { Socket } from 'node:net';

export interface SocksRequest {
  host: string;
  port: number;
}

/**
 * Realiza el saludo SOCKS5 sobre un socket entrante y devuelve el destino pedido.
 * Tras resolver, el llamador debe invocar `reply(ok)` y después canalizar el socket.
 */
export function socks5Handshake(sock: Socket): Promise<{ req: SocksRequest; reply: (ok: boolean) => void }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'request' = 'greet';
    const fail = (msg: string) => {
      sock.removeListener('data', onData);
      sock.destroy();
      reject(new Error(msg));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail('Versión SOCKS no soportada');
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) {
          sock.write(Buffer.from([5, 0xff]));
          return fail('Método de autenticación SOCKS no soportado');
        }
        sock.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[0] !== 5 || buf[1] !== 1) {
          sock.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail('Sólo se soporta CONNECT');
        }
        const atyp = buf[3];
        let host: string;
        let off: number;
        if (atyp === 1) {
          if (buf.length < 10) return;
          host = Array.from(buf.subarray(4, 8)).join('.');
          off = 8;
        } else if (atyp === 3) {
          if (buf.length < 5) return;
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString('utf8');
          off = 5 + len;
        } else if (atyp === 4) {
          if (buf.length < 22) return;
          const parts: string[] = [];
          for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
          host = parts.join(':');
          off = 20;
        } else {
          sock.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail('Tipo de dirección no soportado');
        }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        sock.removeListener('data', onData);
        if (rest.length) sock.unshift(rest);
        resolve({
          req: { host, port },
          reply: (ok) => sock.write(Buffer.from([5, ok ? 0 : 5, 0, 1, 0, 0, 0, 0, 0, 0])),
        });
      }
    };
    sock.on('data', onData);
    sock.once('error', (e) => reject(e));
  });
}
