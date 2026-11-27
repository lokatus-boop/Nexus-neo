// AES-128-OCB3 (RFC 7253) con etiqueta de 128 bits, el cifrado autenticado de Mosh.
// Electron usa BoringSSL, que no trae OCB, así que se implementa sobre AES-ECB (un bloque).
import { createCipheriv, createDecipheriv, Cipheriv, Decipheriv } from 'node:crypto';

const BLOCK = 16;

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(BLOCK);
  for (let i = 0; i < BLOCK; i++) out[i] = a[i] ^ b[i];
  return out;
}

function xorInto(dst: Buffer, src: Buffer): void {
  for (let i = 0; i < BLOCK; i++) dst[i] ^= src[i];
}

/** double(S) de RFC 7253: desplazamiento a la izquierda en GF(2^128). */
function dbl(s: Buffer): Buffer {
  const out = Buffer.allocUnsafe(BLOCK);
  for (let i = 0; i < BLOCK - 1; i++) out[i] = ((s[i] << 1) | (s[i + 1] >>> 7)) & 0xff;
  out[BLOCK - 1] = ((s[BLOCK - 1] << 1) & 0xff) ^ (s[0] & 0x80 ? 0x87 : 0);
  return out;
}

function ntz(n: number): number {
  let z = 0;
  while ((n & 1) === 0) {
    n >>>= 1;
    z++;
  }
  return z;
}

export class Ocb {
  private readonly enc: Cipheriv;
  private readonly dec: Decipheriv;
  private readonly lStar: Buffer;
  private readonly lDollar: Buffer;
  private readonly l: Buffer[] = [];

  constructor(key: Buffer) {
    if (key.length !== 16) throw new Error('La clave de Mosh debe tener 128 bits.');
    this.enc = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
    this.dec = createDecipheriv('aes-128-ecb', key, null).setAutoPadding(false);
    this.lStar = this.encipher(Buffer.alloc(BLOCK));
    this.lDollar = dbl(this.lStar);
    this.l.push(dbl(this.lDollar));
  }

  private encipher(b: Buffer): Buffer {
    return this.enc.update(b);
  }

  private decipher(b: Buffer): Buffer {
    return this.dec.update(b);
  }

  private L(i: number): Buffer {
    while (this.l.length <= i) this.l.push(dbl(this.l[this.l.length - 1]));
    return this.l[i];
  }

  private initialOffset(nonce: Buffer): Buffer {
    if (nonce.length < 1 || nonce.length > 15) throw new Error('Nonce OCB no válido');
    // Nonce = num2str(TAGLEN mod 128, 7) || zeros || 1 || N, con TAGLEN = 128.
    const n = Buffer.alloc(BLOCK);
    nonce.copy(n, BLOCK - nonce.length);
    n[BLOCK - nonce.length - 1] |= 1;
    const bottom = n[BLOCK - 1] & 0x3f;
    n[BLOCK - 1] &= 0xc0;
    const ktop = this.encipher(n);
    const stretch = Buffer.alloc(24);
    ktop.copy(stretch);
    for (let i = 0; i < 8; i++) stretch[16 + i] = ktop[i] ^ ktop[i + 1];
    const byteShift = bottom >>> 3;
    const bitShift = bottom & 7;
    const off = Buffer.allocUnsafe(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const hi = stretch[i + byteShift];
      const lo = stretch[i + byteShift + 1] ?? 0;
      off[i] = bitShift ? ((hi << bitShift) | (lo >>> (8 - bitShift))) & 0xff : hi;
    }
    return off;
  }

  private hash(ad: Buffer): Buffer {
    const sum = Buffer.alloc(BLOCK);
    const offset = Buffer.alloc(BLOCK);
    const full = Math.floor(ad.length / BLOCK);
    for (let i = 1; i <= full; i++) {
      xorInto(offset, this.L(ntz(i)));
      xorInto(sum, this.encipher(xor(ad.subarray((i - 1) * BLOCK, i * BLOCK), offset)));
    }
    const rest = ad.length % BLOCK;
    if (rest) {
      xorInto(offset, this.lStar);
      const pad = Buffer.alloc(BLOCK);
      ad.copy(pad, 0, full * BLOCK);
      pad[rest] = 0x80;
      xorInto(sum, this.encipher(xor(pad, offset)));
    }
    return sum;
  }

  /** Devuelve texto cifrado || etiqueta (16 bytes). */
  encrypt(nonce: Buffer, plaintext: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    const offset = this.initialOffset(nonce);
    const checksum = Buffer.alloc(BLOCK);
    const out = Buffer.allocUnsafe(plaintext.length + BLOCK);
    const full = Math.floor(plaintext.length / BLOCK);
    for (let i = 1; i <= full; i++) {
      const p = plaintext.subarray((i - 1) * BLOCK, i * BLOCK);
      xorInto(offset, this.L(ntz(i)));
      this.encipher(xor(p, offset)).copy(out, (i - 1) * BLOCK);
      for (let k = 0; k < BLOCK; k++) out[(i - 1) * BLOCK + k] ^= offset[k];
      xorInto(checksum, p);
    }
    const rest = plaintext.length % BLOCK;
    if (rest) {
      xorInto(offset, this.lStar);
      const pad = this.encipher(offset);
      for (let k = 0; k < rest; k++) out[full * BLOCK + k] = plaintext[full * BLOCK + k] ^ pad[k];
      const last = Buffer.alloc(BLOCK);
      plaintext.copy(last, 0, full * BLOCK);
      last[rest] = 0x80;
      xorInto(checksum, last);
    }
    const tag = this.encipher(xor(xor(checksum, offset), this.lDollar));
    xorInto(tag, this.hash(ad));
    tag.copy(out, plaintext.length);
    return out;
  }

  /** Descifra texto || etiqueta; devuelve null si la autenticación falla. */
  decrypt(nonce: Buffer, data: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer | null {
    if (data.length < BLOCK) return null;
    const ctLen = data.length - BLOCK;
    const offset = this.initialOffset(nonce);
    const checksum = Buffer.alloc(BLOCK);
    const out = Buffer.allocUnsafe(ctLen);
    const full = Math.floor(ctLen / BLOCK);
    for (let i = 1; i <= full; i++) {
      xorInto(offset, this.L(ntz(i)));
      const p = xor(this.decipher(xor(data.subarray((i - 1) * BLOCK, i * BLOCK), offset)), offset);
      p.copy(out, (i - 1) * BLOCK);
      xorInto(checksum, p);
    }
    const rest = ctLen % BLOCK;
    if (rest) {
      xorInto(offset, this.lStar);
      const pad = this.encipher(offset);
      const last = Buffer.alloc(BLOCK);
      for (let k = 0; k < rest; k++) last[k] = out[full * BLOCK + k] = data[full * BLOCK + k] ^ pad[k];
      last[rest] = 0x80;
      xorInto(checksum, last);
    }
    const tag = this.encipher(xor(xor(checksum, offset), this.lDollar));
    xorInto(tag, this.hash(ad));
    let diff = 0;
    for (let k = 0; k < BLOCK; k++) diff |= tag[k] ^ data[ctLen + k];
    return diff === 0 ? out : null;
  }
}
