// Generación y gestión de claves SSH (formato OpenSSH) e instalación en authorized_keys.
import { utils, SFTPWrapper } from 'ssh2';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export type KeyType = 'ed25519' | 'rsa' | 'ecdsa';

export interface KeyInfo {
  name: string;
  privatePath: string;
  publicKey: string;
  type: string;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
}

export function sshDir(): string {
  return join(homedir(), '.ssh');
}

export function fingerprintPublic(pub: string): string {
  const parsed = utils.parseKey(pub);
  if (parsed instanceof Error) throw parsed;
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  return 'SHA256:' + createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, '');
}

export function validatePublicKey(line: string): string {
  const t = line.trim();
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-[\w@.-]+) [A-Za-z0-9+/=]+( [^\r\n]*)?$/.test(t)) {
    throw new Error('La clave pública no tiene un formato válido de OpenSSH.');
  }
  fingerprintPublic(t);
  return t;
}

// ssh2 genera de vez en cuando (~0,3 % en ed25519) una clave privada que él mismo no sabe leer.
// Se comprueba cada par y se regenera si hace falta.
export function generateKeyPairChecked(type: KeyType, opts: Record<string, unknown> = {}): { private: string; public: string } {
  for (let i = 0; i < 10; i++) {
    const pair = utils.generateKeyPairSync(type, opts as never);
    const parsed = utils.parseKey(pair.private, opts.passphrase as string | undefined);
    if (!(parsed instanceof Error)) return pair;
  }
  throw new Error('No se pudo generar una clave válida.');
}

export async function generateKey(opts: { type: KeyType; bits?: number; comment?: string; passphrase?: string; path: string; overwrite?: boolean }): Promise<KeyInfo> {
  if (!opts.overwrite && (existsSync(opts.path) || existsSync(`${opts.path}.pub`))) {
    throw new Error(`Ya existe una clave en ${opts.path}.`);
  }
  const genOpts: Record<string, unknown> = { comment: opts.comment || '' };
  if (opts.type === 'rsa') genOpts.bits = opts.bits && opts.bits >= 2048 ? opts.bits : 4096;
  if (opts.type === 'ecdsa') genOpts.bits = [256, 384, 521].includes(opts.bits || 0) ? opts.bits : 256;
  if (opts.passphrase) {
    genOpts.passphrase = opts.passphrase;
    genOpts.cipher = 'aes256-ctr';
    genOpts.rounds = 16;
  }
  const pair = generateKeyPairChecked(opts.type, genOpts);
  await fs.mkdir(join(opts.path, '..'), { recursive: true, mode: 0o700 });
  await fs.writeFile(opts.path, pair.private, { mode: 0o600 });
  await fs.writeFile(`${opts.path}.pub`, pair.public.trim() + '\n', { mode: 0o644 });
  return describe(opts.path, pair.public.trim(), !!opts.passphrase);
}

function describe(privatePath: string, pub: string, encrypted: boolean): KeyInfo {
  const [type, , ...rest] = pub.split(' ');
  return { name: basename(privatePath), privatePath, publicKey: pub, type, fingerprint: fingerprintPublic(pub), comment: rest.join(' '), encrypted };
}

export async function listKeys(dir = sshDir()): Promise<KeyInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: KeyInfo[] = [];
  for (const n of names.filter((x) => x.endsWith('.pub')).sort()) {
    try {
      const pub = (await fs.readFile(join(dir, n), 'utf8')).trim();
      const priv = join(dir, n.slice(0, -4));
      let encrypted = false;
      if (existsSync(priv)) {
        const parsed = utils.parseKey(await fs.readFile(priv));
        encrypted = parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message);
      }
      out.push(describe(priv, pub, encrypted));
    } catch {
      /* archivo no válido */
    }
  }
  return out;
}

function p<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

/** Añade la clave a ~/.ssh/authorized_keys del servidor por SFTP (sin pasar por el shell). */
export async function installPublicKey(sftp: SFTPWrapper, publicKey: string): Promise<'added' | 'present'> {
  const key = validatePublicKey(publicKey);
  const home = await p<string>((cb) => sftp.realpath('.', cb as never));
  const dir = `${home.replace(/\/$/, '')}/.ssh`;
  const file = `${dir}/authorized_keys`;
  await p<void>((cb) => sftp.mkdir(dir, { mode: 0o700 }, cb as never)).catch(() => undefined);
  let current = '';
  try {
    current = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      sftp.createReadStream(file).on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  } catch {
    current = '';
  }
  const keyBody = key.split(' ').slice(0, 2).join(' ');
  if (current.split(/\r?\n/).some((l) => l.trim().split(' ').slice(0, 2).join(' ') === keyBody)) return 'present';
  const next = (current && !current.endsWith('\n') ? current + '\n' : current) + key + '\n';
  await new Promise<void>((resolve, reject) => {
    const ws = sftp.createWriteStream(file, { mode: 0o600 });
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(Buffer.from(next, 'utf8'));
  });
  await p<void>((cb) => sftp.chmod(file, 0o600, cb as never)).catch(() => undefined);
  await p<void>((cb) => sftp.chmod(dir, 0o700, cb as never)).catch(() => undefined);
  return 'added';
}
