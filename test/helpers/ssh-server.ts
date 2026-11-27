// Servidor SSH de pruebas (ssh2) con shell de eco, exec, SFTP sobre un directorio
// temporal, reenvío directo (-L/-D/ProxyJump) y reenvío remoto (-R).
import { Server, utils, Connection } from 'ssh2';
import { createServer, connect, AddressInfo, Server as NetServer } from 'node:net';
import { promises as fs, constants as FS, Stats } from 'node:fs';
import { join, normalize } from 'node:path';
import { execFile } from 'node:child_process';
import { generateKeyPairChecked } from '../../src/main/keys';

const { STATUS_CODE } = utils.sftp;

export interface TestServer {
  port: number;
  hostKeyFingerprintSource: Buffer;
  close(): Promise<void>;
}

function toAttrs(st: Stats) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

export async function startTestServer(root: string, creds: { user: string; pass: string; authorizedKeys?: string[] } = { user: 'nexus', pass: 'secreto' }): Promise<TestServer> {
  const allowed = (creds.authorizedKeys || []).map((k) => {
    const p = utils.parseKey(k);
    if (p instanceof Error) throw p;
    return Array.isArray(p) ? p[0] : p;
  });
  const hostKey = generateKeyPairChecked('ed25519');
  const server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
    const remoteListeners: NetServer[] = [];
    client.on('authentication', (ctx) => {
      if (ctx.username === creds.user && ctx.method === 'password' && ctx.password === creds.pass) return ctx.accept();
      if (ctx.method === 'publickey' && ctx.username === creds.user) {
        const k = allowed.find((a) => a.type === ctx.key.algo && a.getPublicSSH().equals(ctx.key.data));
        if (k && (!ctx.signature || k.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          answers[0] === creds.pass && ctx.username === creds.user ? ctx.accept() : ctx.reject());
      }
      ctx.reject(['publickey', 'password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const sock = connect(info.destPort, info.destIP);
        sock.once('connect', () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
          ch.on('close', () => sock.destroy());
          sock.on('close', () => ch.destroy());
        });
        sock.once('error', () => reject());
      });
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward' || !accept || !reject) return reject?.();
        const { bindAddr, bindPort } = info as { bindAddr: string; bindPort: number };
        const l = createServer((s) => {
          client.forwardOut(bindAddr, bindPort, s.remoteAddress || '127.0.0.1', s.remotePort || 0, (err, ch) => {
            if (err) return s.destroy();
            s.pipe(ch).pipe(s);
            ch.on('close', () => s.destroy());
          });
        });
        l.listen(bindPort, bindAddr, () => {
          remoteListeners.push(l);
          accept((l.address() as AddressInfo).port);
        });
        l.once('error', () => reject());
      });
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept?.());
        session.on('window-change', (accept) => accept?.());
        session.on('shell', (accept) => {
          const ch = accept();
          ch.write('Bienvenido al servidor de pruebas\r\n$ ');
          ch.on('data', (d: Buffer) => {
            const t = d.toString();
            if (t.includes('exit')) return ch.close();
            ch.write(`eco:${t}`);
          });
        });
        session.on('exec', (accept, _reject, info) => {
          const ch = accept();
          if (info.command.startsWith('mosh-server new')) {
            // Arranca el mosh-server real de la máquina de pruebas (si existe) escuchando en 127.0.0.1.
            const cmd = info.command.replace(' -s ', ' -i 127.0.0.1 ');
            execFile('sh', ['-c', cmd], { timeout: 10000 }, (err, out, errOut) => {
              if (err && err.code === 127) {
                ch.stderr.write('sh: 1: mosh-server: not found\n');
                ch.exit(127);
              } else {
                ch.write(out);
                ch.stderr.write(errOut);
                ch.exit(0);
              }
              ch.end();
            });
            return;
          }
          if (info.command.includes('/proc/loadavg')) ch.write('0.42 0.30 0.20 1/100 1234\n--\n8000 2000\n--\n37%\n--\n3700.5 100.0\n--\n4\n');
          else ch.write(`exec:${info.command}\n`);
          ch.exit(0);
          ch.end();
        });
        session.on('sftp', (accept) => attachSftp(accept(), root));
      });
    });
    client.on('close', () => remoteListeners.forEach((l) => l.close()));
    client.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const pub = utils.parseKey(hostKey.public);
  return {
    port: (server.address() as AddressInfo).port,
    hostKeyFingerprintSource: (Array.isArray(pub) ? pub[0] : (pub as { getPublicSSH(): Buffer })).getPublicSSH(),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function attachSftp(sftp: any, root: string): void {
  const handles = new Map<number, { fd?: fs.FileHandle; dir?: string; listed?: boolean }>();
  let next = 1;
  const real = (p: string) => join(root, normalize('/' + p).replace(/^\/+/, ''));
  const virt = (p: string) => normalize('/' + p).replace(/\/+$/, '') || '/';
  const fail = (id: number, e: unknown) => sftp.status(id, (e as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
  const newHandle = (h: { fd?: fs.FileHandle; dir?: string }) => {
    const n = next++;
    handles.set(n, h);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const getHandle = (b: Buffer) => handles.get(b.readUInt32BE(0));

  sftp.on('REALPATH', (id: number, p: string) => {
    const v = p === '.' || p === '' ? '/' : virt(p);
    sftp.name(id, [{ filename: v, longname: v, attrs: {} }]);
  });
  for (const ev of ['STAT', 'LSTAT']) {
    sftp.on(ev, async (id: number, p: string) => {
      try {
        sftp.attrs(id, toAttrs(await (ev === 'STAT' ? fs.stat : fs.lstat)(real(p))));
      } catch (e) {
        fail(id, e);
      }
    });
  }
  sftp.on('OPENDIR', async (id: number, p: string) => {
    try {
      if (!(await fs.stat(real(p))).isDirectory()) return sftp.status(id, STATUS_CODE.FAILURE);
      sftp.handle(id, newHandle({ dir: real(p) }));
    } catch (e) {
      fail(id, e);
    }
  });
  sftp.on('READDIR', async (id: number, hb: Buffer) => {
    const h = getHandle(hb);
    if (!h?.dir) return sftp.status(id, STATUS_CODE.FAILURE);
    if (h.listed) return sftp.status(id, STATUS_CODE.EOF);
    h.listed = true;
    const names = await fs.readdir(h.dir);
    const list = [];
    for (const n of names) {
      const st = await fs.lstat(join(h.dir, n));
      list.push({ filename: n, longname: n, attrs: toAttrs(st) });
    }
    sftp.name(id, list);
  });
  sftp.on('OPEN', async (id: number, p: string, flags: number) => {
    try {
      const mode = utils.sftp.flagsToString(flags) || 'r';
      const fd = await fs.open(real(p), mode);
      sftp.handle(id, newHandle({ fd }));
    } catch (e) {
      fail(id, e);
    }
  });
  sftp.on('READ', async (id: number, hb: Buffer, offset: number, len: number) => {
    const h = getHandle(hb);
    if (!h?.fd) return sftp.status(id, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await h.fd.read(buf, 0, len, offset);
    if (bytesRead === 0) return sftp.status(id, STATUS_CODE.EOF);
    sftp.data(id, buf.subarray(0, bytesRead));
  });
  sftp.on('WRITE', async (id: number, hb: Buffer, offset: number, data: Buffer) => {
    const h = getHandle(hb);
    if (!h?.fd) return sftp.status(id, STATUS_CODE.FAILURE);
    await h.fd.write(data, 0, data.length, offset);
    sftp.status(id, STATUS_CODE.OK);
  });
  sftp.on('FSTAT', async (id: number, hb: Buffer) => {
    const h = getHandle(hb);
    if (!h?.fd) return sftp.status(id, STATUS_CODE.FAILURE);
    sftp.attrs(id, toAttrs(await h.fd.stat()));
  });
  sftp.on('CLOSE', async (id: number, hb: Buffer) => {
    const n = hb.readUInt32BE(0);
    const h = handles.get(n);
    handles.delete(n);
    await h?.fd?.close();
    sftp.status(id, STATUS_CODE.OK);
  });
  const simple = (ev: string, fn: (...a: any[]) => Promise<unknown>) =>
    sftp.on(ev, async (id: number, ...args: any[]) => {
      try {
        await fn(...args);
        sftp.status(id, STATUS_CODE.OK);
      } catch (e) {
        fail(id, e);
      }
    });
  simple('MKDIR', (p: string) => fs.mkdir(real(p)));
  simple('RMDIR', (p: string) => fs.rmdir(real(p)));
  simple('REMOVE', (p: string) => fs.unlink(real(p)));
  simple('RENAME', (a: string, b: string) => fs.rename(real(a), real(b)));
  simple('SETSTAT', async (p: string, attrs: { mode?: number }) => {
    if (attrs.mode !== undefined) await fs.chmod(real(p), attrs.mode);
  });
  simple('FSETSTAT', async () => undefined);
  void FS;
}
