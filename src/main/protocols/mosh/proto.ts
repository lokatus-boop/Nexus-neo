// Codificación protobuf mínima de los mensajes de Mosh (transportinstruction.proto,
// userinput.proto y hostinput.proto). Sólo los campos que usa el protocolo.

export const MAX_U64 = (1n << 64n) - 1n;

function varint(v: bigint | number): Buffer {
  let n = BigInt(v);
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

const key = (field: number, wire: number) => varint((field << 3) | wire);
const vField = (field: number, v: bigint | number) => Buffer.concat([key(field, 0), varint(v)]);
const bField = (field: number, b: Buffer) => Buffer.concat([key(field, 2), varint(b.length), b]);

interface Field {
  field: number;
  wire: number;
  int?: bigint;
  bytes?: Buffer;
}

export function readFields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let p = 0;
  const readVarint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (p >= buf.length) throw new Error('protobuf truncado');
      const b = buf[p++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 70n) throw new Error('varint demasiado largo');
    }
  };
  while (p < buf.length) {
    const k = Number(readVarint());
    const field = k >>> 3;
    const wire = k & 7;
    if (wire === 0) out.push({ field, wire, int: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      if (p + len > buf.length) throw new Error('protobuf truncado');
      out.push({ field, wire, bytes: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else throw new Error(`tipo de campo protobuf no soportado: ${wire}`);
  }
  return out;
}

// --- TransportBuffers.Instruction --------------------------------------------

export interface TransportInstruction {
  protocolVersion: number;
  oldNum: bigint;
  newNum: bigint;
  ackNum: bigint;
  throwawayNum: bigint;
  diff: Buffer;
  chaff?: Buffer;
}

export function encodeInstruction(i: TransportInstruction): Buffer {
  return Buffer.concat([
    vField(1, i.protocolVersion),
    vField(2, i.oldNum),
    vField(3, i.newNum),
    vField(4, i.ackNum),
    vField(5, i.throwawayNum),
    bField(6, i.diff),
    bField(7, i.chaff ?? Buffer.alloc(0)),
  ]);
}

export function decodeInstruction(buf: Buffer): TransportInstruction {
  const i: TransportInstruction = { protocolVersion: 0, oldNum: 0n, newNum: 0n, ackNum: 0n, throwawayNum: 0n, diff: Buffer.alloc(0) };
  for (const f of readFields(buf)) {
    if (f.field === 1) i.protocolVersion = Number(f.int);
    else if (f.field === 2) i.oldNum = f.int!;
    else if (f.field === 3) i.newNum = f.int!;
    else if (f.field === 4) i.ackNum = f.int!;
    else if (f.field === 5) i.throwawayNum = f.int!;
    else if (f.field === 6) i.diff = Buffer.from(f.bytes!);
    else if (f.field === 7) i.chaff = Buffer.from(f.bytes!);
  }
  return i;
}

// --- ClientBuffers.UserMessage -----------------------------------------------

export type UserEvent = { type: 'keys'; data: Buffer } | { type: 'resize'; width: number; height: number };

/** Codifica los eventos de teclado y cambio de tamaño (uniendo pulsaciones seguidas). */
export function encodeUserMessage(events: UserEvent[]): Buffer {
  const parts: Buffer[] = [];
  let keys: Buffer[] = [];
  const flush = () => {
    if (!keys.length) return;
    // Instruction { extension keystroke = 2 { keys = 4 } }
    parts.push(bField(1, bField(2, bField(4, Buffer.concat(keys)))));
    keys = [];
  };
  for (const e of events) {
    if (e.type === 'keys') keys.push(e.data);
    else {
      flush();
      parts.push(bField(1, bField(3, Buffer.concat([vField(5, e.width), vField(6, e.height)]))));
    }
  }
  flush();
  return Buffer.concat(parts);
}

export function decodeUserMessage(buf: Buffer): UserEvent[] {
  const out: UserEvent[] = [];
  for (const inst of readFields(buf)) {
    if (inst.field !== 1 || !inst.bytes) continue;
    for (const ext of readFields(inst.bytes)) {
      if (ext.field === 2 && ext.bytes) {
        for (const k of readFields(ext.bytes)) if (k.field === 4 && k.bytes) out.push({ type: 'keys', data: Buffer.from(k.bytes) });
      } else if (ext.field === 3 && ext.bytes) {
        let width = 0;
        let height = 0;
        for (const r of readFields(ext.bytes)) {
          if (r.field === 5) width = Number(r.int);
          if (r.field === 6) height = Number(r.int);
        }
        out.push({ type: 'resize', width, height });
      }
    }
  }
  return out;
}

// --- HostBuffers.HostMessage -------------------------------------------------

export type HostEvent =
  | { type: 'bytes'; data: Buffer }
  | { type: 'resize'; width: number; height: number }
  | { type: 'echoack'; num: bigint };

export function decodeHostMessage(buf: Buffer): HostEvent[] {
  const out: HostEvent[] = [];
  for (const inst of readFields(buf)) {
    if (inst.field !== 1 || !inst.bytes) continue;
    for (const ext of readFields(inst.bytes)) {
      if (!ext.bytes) continue;
      const fields = readFields(ext.bytes);
      if (ext.field === 2) {
        const s = fields.find((f) => f.field === 4);
        if (s?.bytes) out.push({ type: 'bytes', data: Buffer.from(s.bytes) });
      } else if (ext.field === 3) {
        out.push({ type: 'resize', width: Number(fields.find((f) => f.field === 5)?.int ?? 0), height: Number(fields.find((f) => f.field === 6)?.int ?? 0) });
      } else if (ext.field === 7) {
        out.push({ type: 'echoack', num: fields.find((f) => f.field === 8)?.int ?? 0n });
      }
    }
  }
  return out;
}

export function encodeHostMessage(events: HostEvent[]): Buffer {
  return Buffer.concat(events.map((e) => {
    if (e.type === 'bytes') return bField(1, bField(2, bField(4, e.data)));
    if (e.type === 'resize') return bField(1, bField(3, Buffer.concat([vField(5, e.width), vField(6, e.height)])));
    return bField(1, bField(7, vField(8, e.num)));
  }));
}
