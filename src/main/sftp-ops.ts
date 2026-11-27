// Operaciones SFTP de alto nivel (listado, transferencias recursivas, edición de texto).
import type { SFTPWrapper, Stats } from 'ssh2';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { posix } from 'node:path';
import type { SftpEntry } from '../shared/types';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export function permString(mode: number): string {
  const t = (mode & S_IFMT) === S_IFDIR ? 'd' : (mode & S_IFMT) === S_IFLNK ? 'l' : '-';
  const r = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? r[i] : '-';
  return t + s;
}

function p<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

export async function list(sftp: SFTPWrapper, dir: string): Promise<SftpEntry[]> {
  const items = await p<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb as never));
  const out: SftpEntry[] = [];
  for (const it of items) {
    if (it.filename === '.' || it.filename === '..') continue;
    const full = posix.join(dir, it.filename);
    const isLink = (it.attrs.mode & S_IFMT) === S_IFLNK;
    let isDir = (it.attrs.mode & S_IFMT) === S_IFDIR;
    if (isLink) {
      try {
        const st = await p<Stats>((cb) => sftp.stat(full, cb as never));
        isDir = (st.mode & S_IFMT) === S_IFDIR;
      } catch {
        /* enlace roto */
      }
    }
    out.push({
      name: it.filename,
      path: full,
      isDir,
      isLink,
      size: it.attrs.size,
      mtime: it.attrs.mtime * 1000,
      mode: it.attrs.mode,
      permissions: permString(it.attrs.mode),
    });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

export function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return p<string>((cb) => sftp.realpath(path, cb as never));
}

export function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return p<void>((cb) => sftp.mkdir(path, cb as never));
}

export function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return p<void>((cb) => sftp.rename(from, to, cb as never));
}

export function chmod(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return p<void>((cb) => sftp.chmod(path, mode, cb as never));
}

export async function remove(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  if (!isDir) return p<void>((cb) => sftp.unlink(path, cb as never));
  for (const e of await list(sftp, path)) await remove(sftp, e.path, e.isDir && !e.isLink);
  await p<void>((cb) => sftp.rmdir(path, cb as never));
}

export type Progress = (file: string, transferred: number, total: number) => void;

export async function download(sftp: SFTPWrapper, remote: string, localDir: string, onProgress: Progress): Promise<void> {
  const st = await p<Stats>((cb) => sftp.stat(remote, cb as never));
  const target = join(localDir, posix.basename(remote));
  if ((st.mode & S_IFMT) === S_IFDIR) {
    await fs.mkdir(target, { recursive: true });
    for (const e of await list(sftp, remote)) await download(sftp, e.path, target, onProgress);
    return;
  }
  await p<void>((cb) =>
    sftp.fastGet(remote, target, { step: (t: number, _c: number, total: number) => onProgress(remote, t, total) }, cb as never),
  );
  onProgress(remote, st.size, st.size);
}

export async function upload(sftp: SFTPWrapper, local: string, remoteDir: string, onProgress: Progress): Promise<void> {
  const st = await fs.stat(local);
  const target = posix.join(remoteDir, basename(local));
  if (st.isDirectory()) {
    await mkdir(sftp, target).catch(() => undefined);
    for (const name of await fs.readdir(local)) await upload(sftp, join(local, name), target, onProgress);
    return;
  }
  await p<void>((cb) =>
    sftp.fastPut(local, target, { step: (t: number, _c: number, total: number) => onProgress(target, t, total) }, cb as never),
  );
  onProgress(target, st.size, st.size);
}

const MAX_EDIT = 2 * 1024 * 1024;

export async function readText(sftp: SFTPWrapper, path: string): Promise<string> {
  const st = await p<Stats>((cb) => sftp.stat(path, cb as never));
  if (st.size > MAX_EDIT) throw new Error('El archivo es demasiado grande para el editor integrado (máx. 2 MB).');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    sftp
      .createReadStream(path)
      .on('data', (c: Buffer) => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function writeText(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(path);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(Buffer.from(content, 'utf8'));
  });
}
