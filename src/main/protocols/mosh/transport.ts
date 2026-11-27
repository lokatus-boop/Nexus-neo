// Transporte de Mosh (State Synchronization Protocol) sobre UDP, lado cliente.
//
// Cada datagrama: nonce (8 bytes: bit de dirección + secuencia) || AES-128-OCB(marca de tiempo,
// respuesta de marca de tiempo, fragmento). Los fragmentos llevan una instrucción comprimida con
// zlib que dice «pasa del estado old_num al new_num aplicando este diff». El cliente envía su
// flujo de teclas/redimensiones; el servidor envía diffs de pantalla, que aquí se pasan tal cual
// al terminal (xterm.js) en orden. Si un diff llega basado en un estado que no tenemos, se
// descarta y el servidor lo reenvía desde el último estado confirmado.
import { createSocket, Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { deflateSync, inflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Ocb } from './ocb';
import {
  MAX_U64, UserEvent, decodeHostMessage, decodeInstruction, encodeInstruction, encodeUserMessage,
} from './proto';

export const MOSH_PROTOCOL_VERSION = 2;
const SEND_MINDELAY = 8;
const SEND_INTERVAL = 20;
const ACK_INTERVAL = 3000;
const ACK_DELAY = 100;
const PORT_HOP_INTERVAL = 10_000;
const FRAGMENT_PAYLOAD = 1200;
const DIRECTION_TO_CLIENT = 1n << 63n;

export function parseMoshKey(printable: string): Buffer {
  if (!/^[A-Za-z0-9+/]{22}$/.test(printable)) throw new Error('Clave de Mosh no válida.');
  const key = Buffer.from(printable + '==', 'base64');
  if (key.length !== 16 || key.toString('base64') !== printable + '==') throw new Error('Clave de Mosh no válida.');
  return key;
}

/** Interpreta la salida de «mosh-server new»: MOSH CONNECT <puerto> <clave>. */
export function parseMoshConnect(output: string): { port: number; key: string } | null {
  const m = /MOSH CONNECT (\d+) ([A-Za-z0-9+/]{22})(?:\s|$)/.exec(output);
  return m ? { port: Number(m[1]), key: m[2] } : null;
}

interface SentState {
  num: bigint;
  /** Nº total de eventos de usuario incluidos en este estado. */
  count: number;
  time: number;
}

export interface MoshTransportOptions {
  host: string;
  port: number;
  key: string;
  family?: 4 | 6;
}

/**
 * Eventos: 'host' (Buffer para el terminal), 'heard' (ms sin respuesta, cuando cambia),
 * 'closed' (el servidor terminó la sesión), 'error'.
 */
export class MoshTransport extends EventEmitter {
  private readonly ocb: Ocb;
  private sock: Socket | null = null;
  private seq = 0n;
  private instructionId = BigInt(randomBytes(4).readUInt32BE(0));
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  // Envío (nuestro flujo de eventos).
  private events: UserEvent[] = [];
  private baseCount = 0;
  private sent: SentState[] = [{ num: 0n, count: 0, time: 0 }];
  private nextAckTime = 0;
  private pendingDataAck = false;
  private firstUnsentAt = -1;

  // Recepción (pantalla del servidor).
  private hostNum = 0n;
  private assembly: { id: bigint; parts: Buffer[]; total: number } | null = null;
  private savedTs = -1;
  private savedTsAt = 0;
  private srtt = 1000;
  private rttvar = 500;
  private hitRtt = false;
  lastHeard = 0;
  private lastPortChoice = 0;
  private shuttingDown = false;
  private remoteShutdown = false;

  constructor(private readonly opts: MoshTransportOptions) {
    super();
    this.ocb = new Ocb(parseMoshKey(opts.key));
  }

  start(): void {
    this.hopPort();
    this.lastHeard = Date.now();
    this.nextAckTime = Date.now();
    this.timer = setInterval(() => this.tick(), 10);
  }

  sendKeys(data: Buffer): void {
    if (!data.length || this.closed) return;
    this.events.push({ type: 'keys', data });
    this.kick();
  }

  resize(width: number, height: number): void {
    if (this.closed) return;
    this.events.push({ type: 'resize', width, height });
    this.kick();
  }

  /** Termina la sesión en el servidor (como Ctrl+^ . en mosh) y cierra el socket. */
  close(): void {
    if (this.closed) return;
    if (!this.remoteShutdown && this.sock) {
      // Paquetes de cierre: new_num = 2^64-1. Se envían varios por si se pierde alguno.
      this.shuttingDown = true;
      for (let i = 0; i < 3; i++) setTimeout(() => this.sendInstruction(MAX_U64, Buffer.alloc(0)), i * 60);
      setTimeout(() => this.finish(), 250);
    } else this.finish();
    this.closed = true;
  }

  private finish(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.sock?.close();
    } catch {
      /* ya cerrado */
    }
    this.sock = null;
  }

  private kick(): void {
    if (this.firstUnsentAt < 0) this.firstUnsentAt = Date.now();
  }

  private hopPort(): void {
    const old = this.sock;
    const s = createSocket(this.opts.family === 6 || this.opts.host.includes(':') ? 'udp6' : 'udp4');
    s.on('message', (msg) => this.receive(msg));
    s.on('error', (e) => this.emit('error', e));
    this.sock = s;
    this.lastPortChoice = Date.now();
    // El socket anterior sigue recibiendo un rato por si quedan paquetes en vuelo.
    if (old) setTimeout(() => {
      try {
        old.close();
      } catch {
        /* ya cerrado */
      }
    }, 5000);
  }

  private get currentCount(): number {
    return this.baseCount + this.events.length;
  }

  private timeout(): number {
    return Math.min(Math.max(Math.ceil(this.srtt + 4 * this.rttvar), 50), 1000);
  }

  private tick(): void {
    if (this.closed || !this.sock) return;
    const now = Date.now();
    const last = this.sent[this.sent.length - 1];
    const acked = this.sent[0];
    if (this.pendingDataAck && this.nextAckTime > now + ACK_DELAY) this.nextAckTime = now + ACK_DELAY;

    if (this.currentCount !== last.count) {
      // Hay eventos nuevos: se envían tras una pequeña espera para agrupar pulsaciones.
      if (now - this.firstUnsentAt >= SEND_MINDELAY && now - last.time >= SEND_INTERVAL) this.sendState(last.num + 1n);
    } else if (this.currentCount !== acked.count && now - last.time >= this.timeout() + ACK_DELAY) {
      // Sin confirmar: se reenvía el mismo estado.
      this.sendState(last.num);
    } else if (now >= this.nextAckTime) {
      this.sendState(last.num + 1n);
    }

    if (now - this.lastHeard > PORT_HOP_INTERVAL && now - this.lastPortChoice > PORT_HOP_INTERVAL) this.hopPort();
    const silent = now - this.lastHeard;
    this.emit('heard', silent > 6500 ? silent : 0);
  }

  private sendState(num: bigint): void {
    const acked = this.sent[0];
    const count = this.currentCount;
    const diff = count === acked.count ? Buffer.alloc(0) : encodeUserMessage(this.events.slice(acked.count - this.baseCount));
    const now = Date.now();
    const last = this.sent[this.sent.length - 1];
    if (num === last.num) last.time = now;
    else {
      this.sent.push({ num, count, time: now });
      if (this.sent.length > 32) this.sent.splice(this.sent.length - 17, 1);
    }
    this.sendInstruction(num, diff);
    this.firstUnsentAt = -1;
    this.pendingDataAck = false;
    this.nextAckTime = now + ACK_INTERVAL;
  }

  private sendInstruction(newNum: bigint, diff: Buffer): void {
    if (!this.sock) return;
    const inst = encodeInstruction({
      protocolVersion: MOSH_PROTOCOL_VERSION,
      oldNum: this.sent[0].num,
      newNum,
      ackNum: this.remoteShutdown ? MAX_U64 : this.hostNum,
      throwawayNum: this.sent[0].num,
      diff,
      chaff: randomBytes(randomBytes(1)[0] % 17),
    });
    const payload = deflateSync(inst);
    this.instructionId++;
    const count = Math.max(1, Math.ceil(payload.length / FRAGMENT_PAYLOAD));
    for (let i = 0; i < count; i++) {
      const head = Buffer.alloc(10);
      head.writeBigUInt64BE(this.instructionId, 0);
      head.writeUInt16BE((i === count - 1 ? 0x8000 : 0) | i, 8);
      this.sendPacket(Buffer.concat([head, payload.subarray(i * FRAGMENT_PAYLOAD, (i + 1) * FRAGMENT_PAYLOAD)]));
    }
  }

  private sendPacket(fragment: Buffer): void {
    const now = Date.now();
    let reply = 0xffff;
    if (this.savedTs >= 0 && now - this.savedTsAt < 1000) {
      reply = (this.savedTs + (now - this.savedTsAt)) & 0xffff;
      this.savedTs = -1;
    }
    const ts = Buffer.alloc(4);
    ts.writeUInt16BE(now & 0xffff, 0);
    ts.writeUInt16BE(reply, 2);
    const nonce8 = Buffer.alloc(8);
    nonce8.writeBigUInt64BE(this.seq++ & ~DIRECTION_TO_CLIENT, 0);
    const nonce12 = Buffer.concat([Buffer.alloc(4), nonce8]);
    const body = this.ocb.encrypt(nonce12, Buffer.concat([ts, fragment]));
    this.sock!.send(Buffer.concat([nonce8, body]), this.opts.port, this.opts.host);
  }

  private receive(msg: Buffer): void {
    if (this.closed && !this.shuttingDown) return;
    if (msg.length < 24) return;
    const nonce8 = msg.subarray(0, 8);
    if (!(nonce8.readBigUInt64BE(0) & DIRECTION_TO_CLIENT)) return; // paquete en la dirección equivocada
    const plain = this.ocb.decrypt(Buffer.concat([Buffer.alloc(4), nonce8]), msg.subarray(8));
    if (!plain || plain.length < 4 + 10) return; // falla la autenticación: se ignora
    const now = Date.now();
    const ts = plain.readUInt16BE(0);
    const tsReply = plain.readUInt16BE(2);
    if (ts !== 0xffff) {
      this.savedTs = ts;
      this.savedTsAt = now;
    }
    if (tsReply !== 0xffff) {
      const r = (now - tsReply) & 0xffff;
      if (r < 5000) {
        if (!this.hitRtt) {
          this.srtt = r;
          this.rttvar = r / 2;
          this.hitRtt = true;
        } else {
          this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
          this.srtt = 0.875 * this.srtt + 0.125 * r;
        }
      }
    }
    this.lastHeard = now;

    const frag = plain.subarray(4);
    const id = frag.readBigUInt64BE(0);
    const fnum = frag.readUInt16BE(8);
    const final = !!(fnum & 0x8000);
    const index = fnum & 0x7fff;
    if (!this.assembly || this.assembly.id !== id) this.assembly = { id, parts: [], total: -1 };
    this.assembly.parts[index] = Buffer.from(frag.subarray(10));
    if (final) this.assembly.total = index + 1;
    const a = this.assembly;
    if (a.total < 0 || a.parts.filter(Boolean).length !== a.total) return;
    this.assembly = null;
    let inst;
    try {
      inst = decodeInstruction(inflateSync(Buffer.concat(a.parts)));
    } catch {
      return;
    }
    if (inst.protocolVersion !== MOSH_PROTOCOL_VERSION) {
      this.emit('error', new Error('Versión del protocolo Mosh incompatible con el servidor.'));
      return;
    }
    this.processAck(inst.ackNum);
    if (this.shuttingDown) return;
    if (inst.newNum === MAX_U64) {
      // El servidor cierra la sesión (el shell terminó): se confirma y se avisa.
      if (!this.remoteShutdown) {
        this.remoteShutdown = true;
        for (let i = 0; i < 3; i++) setTimeout(() => this.sendInstruction(this.sent[this.sent.length - 1].num, Buffer.alloc(0)), i * 50);
        setTimeout(() => {
          this.closed = true;
          this.finish();
          this.emit('closed');
        }, 200);
      }
      return;
    }
    if (inst.newNum <= this.hostNum || inst.oldNum !== this.hostNum) return;
    this.hostNum = inst.newNum;
    if (inst.diff.length) {
      this.pendingDataAck = true;
      for (const ev of decodeHostMessage(inst.diff)) if (ev.type === 'bytes') this.emit('host', ev.data);
    }
  }

  private processAck(ack: bigint): void {
    const i = this.sent.findIndex((s) => s.num === ack);
    if (i <= 0) return;
    this.sent.splice(0, i);
    const keep = this.sent[0].count - this.baseCount;
    this.events.splice(0, keep);
    this.baseCount = this.sent[0].count;
  }
}
