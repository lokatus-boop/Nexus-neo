// Pasarela RDCleanPath local para el visor RDP integrado.
//
// El cliente RDP (IronRDP en WebAssembly, dentro de una ventana de Nexus Neo) sólo sabe hablar
// por WebSocket. Esta pasarela escucha en 127.0.0.1 con un puerto aleatorio y, por cada ventana,
// un vale (token) de un solo destino: así no puede usarse como proxy abierto. Para cada conexión:
//   1. recibe la PDU RDCleanPath con la petición X.224 del cliente;
//   2. abre el TCP con el servidor (directo o por un túnel SSH) y le reenvía la petición;
//   3. lee la confirmación X.224 y, si el servidor eligió TLS/NLA, negocia TLS con él;
//   4. verifica la huella del certificado (TOFU, como las claves de host SSH);
//   5. devuelve la respuesta X.224 y la cadena de certificados y reenvía los bytes descifrados.
import { connect as netConnect, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import {
  RDCLEANPATH_VERSION, GENERAL_ERROR, NEGOTIATION_ERROR, TARGET_UNREACHABLE, TLS_FAILED,
  decodePdu, encodePdu, pduLength, parseX224Confirm, tpktLength, NEG_FAILURE_TEXT,
} from './rdcleanpath';

export interface RdpTicket {
  host: string;
  port: number;
  /** Abre el transporte hasta el servidor RDP (por defecto, TCP directo). */
  openTransport?: () => Promise<Duplex>;
  /** Decide si se confía en el certificado del servidor. */
  verifyCertificate: (info: { host: string; port: number; fingerprint: string; subject: string; issuer: string }) => Promise<boolean>;
  /** Se llama con una descripción de lo que ocurre (para registro/diagnóstico). */
  onEvent?: (msg: string) => void;
}

export function certFingerprint(der: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(der).digest('base64').replace(/=+$/, '');
}

function readUntil(stream: Duplex, need: (buf: Buffer) => number | null, timeoutMs = 15000): Promise<{ packet: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('El servidor RDP no responde.')), timeoutMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let n: number | null;
      try {
        n = need(buf);
      } catch (e) {
        return fail(e as Error);
      }
      if (n !== null && buf.length >= n) {
        cleanup();
        stream.pause();
        resolve({ packet: buf.subarray(0, n), rest: buf.subarray(n) });
      }
    };
    const onEnd = () => fail(new Error('El servidor RDP cerró la conexión durante la negociación.'));
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', fail);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
    };
    stream.on('data', onData);
    stream.once('error', fail);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.resume();
  });
}

export class RdpGateway {
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly tickets = new Map<string, RdpTicket>();

  async start(): Promise<number> {
    if (this.wss) return this.port;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });
    this.port = (wss.address() as { port: number }).port;
    wss.on('connection', (ws) => void this.handle(ws));
    this.wss = wss;
    return this.port;
  }

  /** Registra un destino y devuelve el vale que el cliente presentará como proxy_auth. */
  issue(ticket: RdpTicket): { url: string; token: string } {
    const token = randomBytes(24).toString('base64url');
    this.tickets.set(token, ticket);
    return { url: `ws://127.0.0.1:${this.port}/rdp`, token };
  }

  revoke(token: string): void {
    this.tickets.delete(token);
  }

  async stop(): Promise<void> {
    this.tickets.clear();
    const w = this.wss;
    this.wss = null;
    if (!w) return;
    for (const c of w.clients) c.terminate();
    await new Promise<void>((r) => w.close(() => r()));
  }

  private async handle(ws: WebSocket): Promise<void> {
    let first = Buffer.alloc(0);
    let transport: Duplex | null = null;
    let tls: TLSSocket | null = null;
    const pendingFromClient: Buffer[] = [];
    let ready = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      tls?.destroy();
      transport?.destroy();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
    const sendError = (errorCode: number, extra: Record<string, unknown> = {}) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode, ...extra } }));
      close();
    };
    ws.on('close', close);
    ws.on('error', close);

    const request = await new Promise<Buffer | null>((resolve) => {
      const onMsg = (data: RawData) => {
        const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (ready) {
          if (tls) tls.write(chunk);
          else pendingFromClient.push(chunk);
          return;
        }
        if (request !== undefined) return void pendingFromClient.push(chunk);
        first = Buffer.concat([first, chunk]);
        try {
          const n = pduLength(first);
          if (n !== null && first.length >= n) {
            if (first.length > n) pendingFromClient.push(first.subarray(n));
            request = first.subarray(0, n);
            resolve(request);
          }
        } catch {
          resolve(null);
        }
      };
      let request: Buffer | undefined;
      ws.on('message', onMsg);
      ws.once('close', () => resolve(null));
    });
    if (!request) return close();

    let pdu;
    try {
      pdu = decodePdu(request);
    } catch {
      return sendError(GENERAL_ERROR, { httpStatusCode: 400 });
    }
    const ticket = pdu.proxyAuth ? this.tickets.get(pdu.proxyAuth) : undefined;
    if (pdu.version !== RDCLEANPATH_VERSION || !ticket) return sendError(GENERAL_ERROR, { httpStatusCode: 401 });
    if (!pdu.x224) return sendError(GENERAL_ERROR, { httpStatusCode: 400 });
    const log = (m: string) => ticket.onEvent?.(m);

    // 1-2. Transporte y petición X.224.
    try {
      transport = ticket.openTransport
        ? await ticket.openTransport()
        : await new Promise<Socket>((resolve, reject) => {
          const s = netConnect({ host: ticket.host, port: ticket.port });
          s.setNoDelay(true);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
    } catch (e) {
      log(`No se pudo conectar con ${ticket.host}:${ticket.port}: ${(e as Error).message}`);
      return sendError(TARGET_UNREACHABLE);
    }
    transport.on('error', (e) => {
      log(`Conexión con el servidor: ${e.message}`);
      close();
    });
    transport.write(pdu.x224);
    let confirm: Buffer;
    try {
      ({ packet: confirm } = await readUntil(transport, tpktLength));
    } catch (e) {
      log((e as Error).message);
      return sendError(TARGET_UNREACHABLE);
    }
    const neg = parseX224Confirm(confirm);
    if (neg.kind === 'failure') {
      log(`Negociación rechazada: ${NEG_FAILURE_TEXT[neg.code] || `código ${neg.code}`}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode: NEGOTIATION_ERROR }, x224: confirm }));
      }
      return close();
    }

    const serverAddr = transport instanceof Socket ? transport.remoteAddress || ticket.host : ticket.host;
    let chain: Buffer[] = [];
    if (neg.kind === 'ok' && neg.protocol !== 0) {
      // 3. TLS con el servidor. La verificación se hace por huella (TOFU) más abajo, porque los
      // servidores RDP casi siempre usan certificados autofirmados.
      try {
        tls = await new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect({ socket: transport!, rejectUnauthorized: false, servername: /^[\d.:]+$/.test(ticket.host) ? undefined : ticket.host });
          t.once('secureConnect', () => resolve(t));
          t.once('error', reject);
        });
      } catch (e) {
        log(`TLS: ${(e as Error).message}`);
        return sendError(TLS_FAILED);
      }
      const peer = tls.getPeerCertificate(true);
      const seen = new Set<string>();
      for (let c = peer; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        chain.push(Buffer.from(c.raw));
      }
      if (!chain.length) return sendError(TLS_FAILED);
      // 4. Huella del certificado.
      const ok = await ticket.verifyCertificate({
        host: ticket.host,
        port: ticket.port,
        fingerprint: certFingerprint(chain[0]),
        subject: peer.subject?.CN ? String(peer.subject.CN) : '',
        issuer: peer.issuer?.CN ? String(peer.issuer.CN) : '',
      }).catch(() => false);
      if (!ok || closed) return sendError(GENERAL_ERROR, { httpStatusCode: 403 });
    }

    // 5. Respuesta y reenvío.
    const data = tls || transport;
    ws.send(encodePdu({ version: RDCLEANPATH_VERSION, x224: confirm, serverCertChain: chain, serverAddr }));
    log('Conectado');
    data.on('data', (d: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    data.on('close', close);
    data.on('end', close);
    data.on('error', close);
    data.resume();
    ready = true;
    if (!tls) tls = null;
    for (const c of pendingFromClient.splice(0)) data.write(c);
    // A partir de aquí los mensajes del cliente van directos al servidor.
    ws.removeAllListeners('message');
    ws.on('message', (m: RawData) => {
      const chunk = Buffer.isBuffer(m) ? m : Array.isArray(m) ? Buffer.concat(m) : Buffer.from(m as ArrayBuffer);
      data.write(chunk);
    });
  }
}
