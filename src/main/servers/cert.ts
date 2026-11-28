// Generación de certificados X.509 autofirmados (ECDSA P-256) sin dependencias externas.
// Node no trae un generador de certificados, así que el DER se construye a mano.
import { generateKeyPairSync, sign, createPrivateKey, X509Certificate, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), len(b.length), b]);
};
const seq = (...b: Buffer[]) => tlv(0x30, ...b);
const set = (...b: Buffer[]) => tlv(0x31, ...b);
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));

function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  // UTCTime hasta 2049, GeneralizedTime después (RFC 5280 §4.1.2.5).
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii')) : tlv(0x18, Buffer.from(iso, 'ascii'));
}

function ipBytes(ip: string): Buffer | null {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  if (isIP(ip) === 6) {
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    if (!ip.includes('::') && h.length !== 8) return null;
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
  }
  return null;
}

export interface GeneratedCert {
  cert: string;
  key: string;
}

/** Crea un certificado autofirmado válido para `names` (nombres DNS o IP). */
export function selfSignedCert(commonName: string, names: string[], days = 825): GeneratedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))), set(seq(oid('2.5.4.10'), utf8('Nexus Neo'))));
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 86400 * 1000);
  const san = [...new Set(names)].map((n) => {
    const ip = ipBytes(n);
    return ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(n, 'ascii'));
  });
  const ext = (id: string, value: Buffer, critical = false) =>
    seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
  const extensions = seq(
    ext('2.5.29.19', seq(), true), // basicConstraints: CA=false
    ext('2.5.29.15', bitString(Buffer.from([0x80])), true), // keyUsage: digitalSignature
    ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    ext('2.5.29.17', seq(...san)), // subjectAltName
  );
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    tlv(0xa3, extensions),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, bitString(signature));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

/** Nombres que debe cubrir el certificado: el equipo, localhost y todas sus IP. */
export function localNames(): string[] {
  const names = ['localhost', osHostname(), '127.0.0.1', '::1'];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) if (!a.address.startsWith('fe80')) names.push(a.address);
  }
  return names.filter((n) => /^[\w.:-]+$/.test(n));
}

/**
 * Devuelve el certificado autofirmado guardado en `dir`, o crea uno nuevo si no existe,
 * ha caducado o le faltan IP actuales del equipo.
 */
export async function loadOrCreateSelfSigned(dir: string): Promise<GeneratedCert & { created: boolean; fingerprint: string }> {
  const certPath = join(dir, 'https-cert.pem');
  const keyPath = join(dir, 'https-key.pem');
  const names = localNames();
  try {
    const [cert, key] = await Promise.all([fs.readFile(certPath, 'utf8'), fs.readFile(keyPath, 'utf8')]);
    const x = new X509Certificate(cert);
    const valid = new Date(x.validTo).getTime() > Date.now() + 86400 * 1000;
    const covers = names.every((n) => (isIP(n) ? x.checkIP(n) : x.checkHost(n)));
    if (valid && covers && x.checkPrivateKey(createPrivateKey(key))) return { cert, key, created: false, fingerprint: x.fingerprint256 };
  } catch {
    /* no existe o no se puede leer: se genera */
  }
  const gen = selfSignedCert(osHostname() || 'nexus-neo', names);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(keyPath, gen.key, { mode: 0o600 });
  await fs.writeFile(certPath, gen.cert);
  return { ...gen, created: true, fingerprint: new X509Certificate(gen.cert).fingerprint256 };
}
