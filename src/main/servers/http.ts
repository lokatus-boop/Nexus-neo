// Servidor HTTP/HTTPS de archivos: listados de carpeta, descargas con Range y subida por PUT opcional.
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { AddressInfo, Socket } from 'node:net';
import { extname, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BuiltinServer, safeResolve, friendlyListenError } from './common';
import { loadOrCreateSelfSigned } from './cert';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml',
  '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class HttpFileServer extends BuiltinServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  boundPort(): number | undefined {
    return (this.server?.address() as AddressInfo | null)?.port;
  }

  private get tls(): boolean {
    return this.cfg.kind === 'https';
  }

  private get label(): string {
    return this.tls ? 'HTTPS' : 'HTTP';
  }

  /** Certificado y clave: los del usuario si se indican, si no uno autofirmado persistente. */
  private async credentials(): Promise<{ cert: string; key: string; note: string }> {
    const { tlsCertPath, tlsKeyPath } = this.cfg;
    if (tlsCertPath || tlsKeyPath) {
      if (!tlsCertPath || !tlsKeyPath) throw new Error('Indica a la vez el certificado y la clave privada, o deja ambos vacíos para usar uno autofirmado.');
      let cert: string;
      let key: string;
      try {
        [cert, key] = await Promise.all([fs.readFile(tlsCertPath, 'utf8'), fs.readFile(tlsKeyPath, 'utf8')]);
      } catch (e) {
        throw new Error(`No se pudo leer el certificado o la clave: ${(e as Error).message}`);
      }
      let x: X509Certificate;
      try {
        x = new X509Certificate(cert);
      } catch {
        throw new Error('El certificado no es un PEM X.509 válido.');
      }
      try {
        if (!x.checkPrivateKey(createPrivateKey(key))) throw new Error('x');
      } catch {
        throw new Error('La clave privada no corresponde al certificado (o está cifrada).');
      }
      if (new Date(x.validTo).getTime() < Date.now()) this.log('warn', `El certificado caducó el ${new Date(x.validTo).toLocaleDateString()}`);
      return { cert, key, note: `certificado ${x.subject.replace(/\n/g, ', ')}` };
    }
    const gen = await loadOrCreateSelfSigned(this.stateDir);
    return { cert: gen.cert, key: gen.key, note: `certificado autofirmado${gen.created ? ' nuevo' : ''} · SHA-256 ${gen.fingerprint}` };
  }

  async start(): Promise<void> {
    await fs.mkdir(this.cfg.rootDir, { recursive: true });
    const handler = (req: IncomingMessage, res: ServerResponse) => void this.handle(req, res);
    let note = '';
    let server: Server;
    if (this.tls) {
      const c = await this.credentials();
      note = ` · ${c.note}`;
      server = createTlsServer({ cert: c.cert, key: c.key }, handler);
      server.on('tlsClientError', (e: Error, s: Socket) => this.log('warn', `${s.remoteAddress?.replace(/^::ffff:/, '') || '?'} error TLS: ${e.message}`));
    } else server = createServer(handler);
    server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      server.listen(this.cfg.port, this.cfg.bindHost || '0.0.0.0', () => resolve());
    });
    this.server = server;
    this.running = true;
    this.log('info', `${this.label} escuchando en ${this.cfg.bindHost || '0.0.0.0'}:${this.boundPort()} · raíz ${this.cfg.rootDir}${this.cfg.allowWrite ? ' · PUT permitido' : ''}${note}`);
    this.changed();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.running = false;
    this.log('info', `${this.label} detenido`);
    this.changed();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '?';
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    } catch {
      return this.end(res, 400, 'Petición no válida');
    }
    const path = safeResolve(this.cfg.rootDir, urlPath);
    if (!path) {
      this.log('warn', `${who} intentó salir de la carpeta raíz: ${urlPath}`);
      return this.end(res, 403, 'Prohibido');
    }
    res.setHeader('Server', 'NexusNeo');

    if (req.method === 'PUT') {
      if (!this.cfg.allowWrite) return this.end(res, 403, 'Escritura deshabilitada');
      await fs.mkdir(dirname(path), { recursive: true });
      try {
        await this.track(pipeline(req, createWriteStream(path)));
        const size = (await fs.stat(path)).size;
        this.log('transfer', `${who} subió ${urlPath} (${size} bytes)`);
        return this.end(res, 201, 'Creado');
      } catch (e) {
        return this.end(res, 500, (e as Error).message);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.end(res, 405, 'Método no permitido');

    const st = await fs.stat(path).catch(() => null);
    if (!st) {
      this.log('warn', `${who} GET ${urlPath} → 404`);
      return this.end(res, 404, 'No encontrado');
    }
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { Location: encodeURI(urlPath + '/') });
        return void res.end();
      }
      const names = (await fs.readdir(path, { withFileTypes: true })).filter((d) => !d.name.startsWith('.'));
      names.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      const rows = names.map((d) => {
        const n = d.name + (d.isDirectory() ? '/' : '');
        return `<li><a href="${esc(encodeURIComponent(d.name))}${d.isDirectory() ? '/' : ''}">${esc(n)}</a></li>`;
      });
      const html = `<!doctype html><meta charset="utf-8"><title>${esc(urlPath)}</title><style>body{font:14px system-ui;margin:2em}a{text-decoration:none}li{margin:.2em 0}</style><h1>Índice de ${esc(urlPath)}</h1><ul>${urlPath !== '/' ? '<li><a href="../">../</a></li>' : ''}${rows.join('')}</ul>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return void res.end(req.method === 'HEAD' ? undefined : html);
    }

    // Archivo, con soporte de Range para reanudar descargas.
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = range[1] ? Math.min(Number(range[2]), end) : st.size - 1;
      if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return void res.end();
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.writeHead(status, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size === 0 ? 0 : end - start + 1,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    });
    if (req.method === 'HEAD' || st.size === 0) return void res.end();
    const t0 = Date.now();
    try {
      await this.track(pipeline(createReadStream(path, { start, end }), res));
      this.log('transfer', `${who} descargó ${urlPath} (${end - start + 1} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch {
      this.log('warn', `${who} canceló la descarga de ${urlPath}`);
    }
  }

  private end(res: ServerResponse, code: number, msg: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg + '\n');
  }
}
