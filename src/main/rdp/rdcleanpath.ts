// Codificación DER de las PDU RDCleanPath (versión 3390) que usa el cliente RDP integrado
// (IronRDP compilado a WebAssembly). El cliente envía por WebSocket la petición X.224 y el
// destino; la pasarela local abre el TCP, negocia TLS con el servidor RDP y devuelve la
// respuesta X.224 junto con la cadena de certificados. A partir de ahí sólo se reenvían bytes.
//
// RDCleanPathPdu ::= SEQUENCE {            -- todas las etiquetas son EXPLICIT
//   version [0] INTEGER, error [1] RDCleanPathErr OPTIONAL, destination [2] UTF8String OPTIONAL,
//   proxyAuth [3] UTF8String OPTIONAL, serverAuth [4] UTF8String OPTIONAL,
//   preconnectionBlob [5] UTF8String OPTIONAL, x224ConnectionPdu [6] OCTET STRING OPTIONAL,
//   serverCertChain [7] SEQUENCE OF OCTET STRING OPTIONAL, serverAddr [9] UTF8String OPTIONAL }
// RDCleanPathErr ::= SEQUENCE { errorCode [0] INTEGER, httpStatusCode [1] INTEGER OPTIONAL,
//   wsaLastError [2] INTEGER OPTIONAL, tlsAlertCode [3] INTEGER OPTIONAL }

export const RDCLEANPATH_VERSION = 3390;
export const GENERAL_ERROR = 1;
export const NEGOTIATION_ERROR = 2;
export const TARGET_UNREACHABLE = 103;
export const DNS_FAILED = 104;
export const TLS_FAILED = 105;

export interface RDCleanPathError {
  errorCode: number;
  httpStatusCode?: number;
  wsaLastError?: number;
  tlsAlertCode?: number;
}

export interface RDCleanPathPdu {
  version: number;
  error?: RDCleanPathError;
  destination?: string;
  proxyAuth?: string;
  serverAuth?: string;
  preconnectionBlob?: string;
  x224?: Buffer;
  serverCertChain?: Buffer[];
  serverAddr?: string;
}

// --- DER mínimo -------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(value.length), value]);
}

function integer(n: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b: Buffer) => tlv(0x04, b);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);

interface Node {
  tag: number;
  value: Buffer;
}

/** Lee un TLV; devuelve null si faltan bytes. */
function readTlv(buf: Buffer, off: number): { node: Node; end: number } | null {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let l = buf[off + 1];
  let p = off + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (n === 0 || n > 4) throw new Error('Longitud DER no válida');
    if (p + n > buf.length) return null;
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + buf[p + i];
    p += n;
  }
  if (p + l > buf.length) return null;
  return { node: { tag, value: buf.subarray(p, p + l) }, end: p + l };
}

function children(value: Buffer): Node[] {
  const out: Node[] = [];
  let off = 0;
  while (off < value.length) {
    const r = readTlv(value, off);
    if (!r) throw new Error('DER truncado');
    out.push(r.node);
    off = r.end;
  }
  return out;
}

function readInt(n: Node): number {
  if (n.tag !== 0x02) throw new Error('Se esperaba INTEGER');
  let v = 0;
  for (const b of n.value) v = v * 256 + b;
  return v;
}

function readStr(n: Node): string {
  if (n.tag !== 0x0c) throw new Error('Se esperaba UTF8String');
  return n.value.toString('utf8');
}

function readOctets(n: Node): Buffer {
  if (n.tag !== 0x04) throw new Error('Se esperaba OCTET STRING');
  return Buffer.from(n.value);
}

/** Longitud total de la PDU si el búfer ya contiene la cabecera; null si faltan bytes. */
export function pduLength(buf: Buffer): number | null {
  if (buf.length < 2) return null;
  if (buf[0] !== 0x30) throw new Error('No es una PDU RDCleanPath');
  const l = buf[1];
  if (!(l & 0x80)) return 2 + l;
  const n = l & 0x7f;
  if (buf.length < 2 + n) return null;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[2 + i];
  return 2 + n + v;
}

export function encodePdu(p: RDCleanPathPdu): Buffer {
  const parts: Buffer[] = [explicit(0, integer(p.version))];
  if (p.error) {
    const e = p.error;
    const err: Buffer[] = [explicit(0, integer(e.errorCode))];
    if (e.httpStatusCode !== undefined) err.push(explicit(1, integer(e.httpStatusCode)));
    if (e.wsaLastError !== undefined) err.push(explicit(2, integer(e.wsaLastError)));
    if (e.tlsAlertCode !== undefined) err.push(explicit(3, integer(e.tlsAlertCode)));
    parts.push(explicit(1, seq(...err)));
  }
  if (p.destination !== undefined) parts.push(explicit(2, utf8(p.destination)));
  if (p.proxyAuth !== undefined) parts.push(explicit(3, utf8(p.proxyAuth)));
  if (p.serverAuth !== undefined) parts.push(explicit(4, utf8(p.serverAuth)));
  if (p.preconnectionBlob !== undefined) parts.push(explicit(5, utf8(p.preconnectionBlob)));
  if (p.x224) parts.push(explicit(6, octets(p.x224)));
  if (p.serverCertChain) parts.push(explicit(7, seq(...p.serverCertChain.map(octets))));
  if (p.serverAddr !== undefined) parts.push(explicit(9, utf8(p.serverAddr)));
  return seq(...parts);
}

export function decodePdu(buf: Buffer): RDCleanPathPdu {
  const top = readTlv(buf, 0);
  if (!top || top.node.tag !== 0x30) throw new Error('PDU RDCleanPath no válida');
  const pdu: RDCleanPathPdu = { version: 0 };
  for (const field of children(top.node.value)) {
    if ((field.tag & 0xe0) !== 0xa0) throw new Error('Etiqueta inesperada en RDCleanPath');
    const [inner] = children(field.value);
    switch (field.tag & 0x1f) {
      case 0: pdu.version = readInt(inner); break;
      case 1: {
        const e: RDCleanPathError = { errorCode: GENERAL_ERROR };
        for (const f of children(inner.value)) {
          const [v] = children(f.value);
          const k = f.tag & 0x1f;
          if (k === 0) e.errorCode = readInt(v);
          else if (k === 1) e.httpStatusCode = readInt(v);
          else if (k === 2) e.wsaLastError = readInt(v);
          else if (k === 3) e.tlsAlertCode = readInt(v);
        }
        pdu.error = e;
        break;
      }
      case 2: pdu.destination = readStr(inner); break;
      case 3: pdu.proxyAuth = readStr(inner); break;
      case 4: pdu.serverAuth = readStr(inner); break;
      case 5: pdu.preconnectionBlob = readStr(inner); break;
      case 6: pdu.x224 = readOctets(inner); break;
      case 7: pdu.serverCertChain = children(inner.value).map(readOctets); break;
      case 9: pdu.serverAddr = readStr(inner); break;
      default: break; // campos futuros: se ignoran
    }
  }
  return pdu;
}

// --- X.224 ------------------------------------------------------------------

export type X224Result =
  | { kind: 'ok'; protocol: number }
  | { kind: 'failure'; code: number }
  | { kind: 'legacy' };

/** Longitud de un paquete TPKT completo al principio del búfer, o null si aún no está entero. */
export function tpktLength(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 3) throw new Error('Respuesta del servidor RDP no válida (no es TPKT).');
  return buf.readUInt16BE(2);
}

/** Interpreta la confirmación de conexión X.224 (RDP_NEG_RSP / RDP_NEG_FAILURE). */
export function parseX224Confirm(pkt: Buffer): X224Result {
  // TPKT(4) + LI(1) + CC(1) + dst(2) + src(2) + class(1) = 11 bytes; luego la negociación (8 bytes).
  if (pkt.length < 11 || (pkt[5] & 0xf0) !== 0xd0) throw new Error('El servidor no aceptó la conexión X.224.');
  if (pkt.length < 19) return { kind: 'legacy' };
  const type = pkt[11];
  const value = pkt.readUInt32LE(15);
  if (type === 0x02) return { kind: 'ok', protocol: value };
  if (type === 0x03) return { kind: 'failure', code: value };
  return { kind: 'legacy' };
}

export const NEG_FAILURE_TEXT: Record<number, string> = {
  1: 'el servidor exige TLS',
  2: 'el servidor exige autenticación a nivel de red (NLA/CredSSP)',
  3: 'el servidor no tiene certificado TLS',
  4: 'la conexión no está permitida por la configuración del servidor',
  5: 'el servidor exige autenticación del cliente',
  6: 'el servidor exige autenticación Kerberos/NLA extendida',
};
