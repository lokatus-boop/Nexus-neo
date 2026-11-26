// Bóveda de credenciales cifrada con contraseña maestra.
// KDF: scrypt (N=2^15, r=8, p=1) -> clave de 256 bits. Cifrado: AES-256-GCM.
// El archivo nunca contiene secretos en claro; la clave sólo vive en memoria
// mientras la bóveda está desbloqueada.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { SecretEntry } from '../shared/types';

interface VaultFile {
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
  /** HMAC-like check value para distinguir contraseña errónea de archivo corrupto. */
  check: string;
}

interface VaultPlain {
  secrets: Record<string, SecretEntry>;
}

const KDF = { N: 1 << 15, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, params = KDF): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 32, { ...params, maxmem: MAXMEM });
}

function checkValue(key: Buffer): string {
  // Cifra un bloque fijo con la clave: permite verificar la contraseña sin descifrar datos.
  const c = createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([c.update(Buffer.alloc(16, 0x4e)), c.final()]).subarray(0, 16).toString('base64');
}

export class Vault {
  private key: Buffer | null = null;
  private plain: VaultPlain | null = null;
  private salt: Buffer | null = null;

  constructor(private readonly file: string) {}

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      return false;
    }
  }

  isUnlocked(): boolean {
    return this.key !== null && this.plain !== null;
  }

  async create(password: string): Promise<void> {
    if (password.length < 8) throw new Error('La contraseña maestra debe tener al menos 8 caracteres.');
    if (await this.exists()) throw new Error('La bóveda ya existe.');
    this.salt = randomBytes(16);
    this.key = deriveKey(password, this.salt);
    this.plain = { secrets: {} };
    await this.save();
  }

  async unlock(password: string): Promise<void> {
    const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as VaultFile;
    if (raw.version !== 1 || raw.kdf.name !== 'scrypt') throw new Error('Formato de bóveda no soportado.');
    const salt = Buffer.from(raw.kdf.salt, 'base64');
    const key = deriveKey(password, salt, { N: raw.kdf.N, r: raw.kdf.r, p: raw.kdf.p });
    const expected = Buffer.from(raw.check, 'base64');
    const got = Buffer.from(checkValue(key), 'base64');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      throw new Error('Contraseña maestra incorrecta.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8');
    this.plain = JSON.parse(json) as VaultPlain;
    this.key = key;
    this.salt = salt;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.plain = null;
    this.salt = null;
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new Error('La contraseña maestra debe tener al menos 8 caracteres.');
    await this.unlock(oldPassword);
    this.salt = randomBytes(16);
    this.key = deriveKey(newPassword, this.salt);
    await this.save();
  }

  get(id: string): SecretEntry | undefined {
    this.assertUnlocked();
    return this.plain!.secrets[id];
  }

  has(id: string): boolean {
    return this.isUnlocked() && !!this.plain!.secrets[id];
  }

  async set(id: string, entry: SecretEntry): Promise<void> {
    this.assertUnlocked();
    const clean: SecretEntry = {};
    if (entry.password) clean.password = entry.password;
    if (entry.passphrase) clean.passphrase = entry.passphrase;
    if (Object.keys(clean).length === 0) delete this.plain!.secrets[id];
    else this.plain!.secrets[id] = clean;
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (!this.isUnlocked()) return;
    delete this.plain!.secrets[id];
    await this.save();
  }

  private assertUnlocked(): void {
    if (!this.isUnlocked()) throw new Error('La bóveda está bloqueada.');
  }

  private async save(): Promise<void> {
    this.assertUnlocked();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key!, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(this.plain), 'utf8'), cipher.final()]);
    const out: VaultFile = {
      version: 1,
      kdf: { name: 'scrypt', ...KDF, salt: this.salt!.toString('base64') },
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      check: checkValue(this.key!),
    };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
