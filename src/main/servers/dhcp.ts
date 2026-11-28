// Servidor DHCP (RFC 2131/2132) para IPv4: rango de direcciones, reservas por MAC, puerta de enlace,
// DNS, dominio y opciones 66/67 (TFTP y archivo de arranque) para teléfonos IP, PXE y ZTP.
// Pensado para redes de laboratorio o de aprovisionamiento: en una red con otro servidor DHCP
// provocaría conflictos.
import { createSocket, Socket, RemoteInfo } from 'node:dgram';
import { promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import { BuiltinServer, friendlyListenError } from './common';
import type { DhcpLease, ServerConfig, ServerStatus } from '../../shared/types';

export const MSG = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 } as const;
const MSG_NAME: Record<number, string> = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));
const MAGIC = 0x63825363;
const OFFER_HOLD_MS = 60_000;

export const ipToInt = (ip: string): number => ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) >>> 0;
export const intToIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function normMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) throw new Error(`MAC no válida: ${mac}`);
  return hex.match(/../g)!.join(':');
}

export interface DhcpPacket {
  op: number;
  htype: number;
  hlen: number;
  hops: number;
  xid: number;
  secs: number;
  flags: number;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  chaddr: Buffer;
  sname: string;
  file: string;
  options: Map<number, Buffer>;
}

export function parsePacket(b: Buffer): DhcpPacket | null {
  if (b.length < 240 || b.readUInt32BE(236) !== MAGIC) return null;
  const ip = (o: number) => intToIp(b.readUInt32BE(o));
  const options = new Map<number, Buffer>();
  let i = 240;
  while (i < b.length) {
    const code = b[i++];
    if (code === 0) continue;
    if (code === 255) break;
    if (i >= b.length) break;
    const l = b[i++];
    const v = b.subarray(i, i + l);
    i += l;
    // RFC 3396: una opción repetida se concatena.
    options.set(code, options.has(code) ? Buffer.concat([options.get(code)!, v]) : Buffer.from(v));
  }
  const str = (s: number, n: number) => b.subarray(s, s + n).toString('latin1').replace(/\0.*$/s, '');
  return {
    op: b[0], htype: b[1], hlen: b[2], hops: b[3], xid: b.readUInt32BE(4), secs: b.readUInt16BE(8), flags: b.readUInt16BE(10),
    ciaddr: ip(12), yiaddr: ip(16), siaddr: ip(20), giaddr: ip(24), chaddr: Buffer.from(b.subarray(28, 44)),
    sname: str(44, 64), file: str(108, 128), options,
  };
}

export function buildPacket(p: Partial<DhcpPacket> & { options: Map<number, Buffer> }): Buffer {
  const out: Buffer[] = [];
  const head = Buffer.alloc(240);
  head[0] = p.op ?? 2;
  head[1] = p.htype ?? 1;
  head[2] = p.hlen ?? 6;
  head[3] = p.hops ?? 0;
  head.writeUInt32BE(p.xid ?? 0, 4);
  head.writeUInt16BE(p.secs ?? 0, 8);
  head.writeUInt16BE(p.flags ?? 0, 10);
  head.writeUInt32BE(ipToInt(p.ciaddr ?? '0.0.0.0'), 12);
  head.writeUInt32BE(ipToInt(p.yiaddr ?? '0.0.0.0'), 16);
  head.writeUInt32BE(ipToInt(p.siaddr ?? '0.0.0.0'), 20);
  head.writeUInt32BE(ipToInt(p.giaddr ?? '0.0.0.0'), 24);
  p.chaddr?.copy(head, 28, 0, 16);
  if (p.sname) head.write(p.sname.slice(0, 63), 44, 'latin1');
  if (p.file) head.write(p.file.slice(0, 127), 108, 'latin1');
  head.writeUInt32BE(MAGIC, 236);
  out.push(head);
  for (const [code, value] of p.options) {
    for (let o = 0; o < value.length || o === 0; o += 255) {
      const part = value.subarray(o, o + 255);
      out.push(Buffer.from([code, part.length]), part);
      if (value.length === 0) break;
    }
  }
  out.push(Buffer.from([255]));
  const pkt = Buffer.concat(out);
  // Algunos clientes antiguos (BOOTP) rechazan respuestas de menos de 300 bytes.
  return pkt.length < 300 ? Buffer.concat([pkt, Buffer.alloc(300 - pkt.length)]) : pkt;
}

const ipOpt = (...ips: string[]) => Buffer.concat(ips.map((ip) => { const b = Buffer.alloc(4); b.writeUInt32BE(ipToInt(ip)); return b; }));
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const splitList = (s?: string) => (s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export interface DhcpSettings {
  serverIp: string;
  poolStart: number;
  poolEnd: number;
  mask: number;
  router?: string;
  dns: string[];
  domain?: string;
  leaseSecs: number;
  tftpServer?: string;
  bootFile?: string;
  reservations: Map<string, { ip: string; name?: string }>;
}

/** Comprueba y convierte la configuración del usuario. */
export function dhcpSettings(cfg: ServerConfig, serverIp: string): DhcpSettings {
  const need = (v: string | undefined, what: string): string => {
    if (!v || !isIPv4(v)) throw new Error(`${what} no es una dirección IPv4 válida${v ? `: ${v}` : ''}.`);
    return v;
  };
  const start = ipToInt(need(cfg.dhcpPoolStart, 'El inicio del rango'));
  const end = ipToInt(need(cfg.dhcpPoolEnd, 'El final del rango'));
  const mask = ipToInt(need(cfg.dhcpSubnetMask || '255.255.255.0', 'La máscara'));
  if (!/^1*0*$/.test(mask.toString(2).padStart(32, '0'))) throw new Error('La máscara de subred no es válida.');
  if (start > end) throw new Error('El inicio del rango es mayor que el final.');
  if (end - start > 65535) throw new Error('El rango es demasiado grande (máximo 65 536 direcciones).');
  const net = (start & mask) >>> 0;
  if (((end & mask) >>> 0) !== net) throw new Error('El inicio y el final del rango no están en la misma subred.');
  const bcast = (net | ~mask) >>> 0;
  if (start === net || end === bcast) throw new Error('El rango no puede incluir la dirección de red ni la de difusión.');
  const router = cfg.dhcpRouter?.trim() ? need(cfg.dhcpRouter.trim(), 'La puerta de enlace') : undefined;
  const dns = splitList(cfg.dhcpDns).map((d) => need(d, 'Un servidor DNS'));
  const reservations = new Map<string, { ip: string; name?: string }>();
  for (const r of cfg.dhcpReservations || []) {
    const ip = need(r.ip, `La reserva de ${r.mac}`);
    if (((ipToInt(ip) & mask) >>> 0) !== net) throw new Error(`La reserva ${ip} no está en la subred del rango.`);
    reservations.set(normMac(r.mac), { ip, name: r.name });
  }
  return {
    serverIp, poolStart: start, poolEnd: end, mask, router, dns, domain: cfg.dhcpDomain?.trim() || undefined,
    leaseSecs: Math.max(60, Math.min(30 * 86400, Number(cfg.dhcpLeaseSecs) || 86400)),
    tftpServer: cfg.dhcpTftpServer?.trim() || undefined, bootFile: cfg.dhcpBootFile?.trim() || undefined, reservations,
  };
}

/** Busca la IP de este equipo que está en la subred del rango (o la elegida en «Escuchar en»). */
export function pickServerIp(cfg: ServerConfig): string {
  const mask = ipToInt(cfg.dhcpSubnetMask || '255.255.255.0');
  const net = (ipToInt(cfg.dhcpPoolStart || '0.0.0.0') & mask) >>> 0;
  if (cfg.bindHost && isIPv4(cfg.bindHost) && cfg.bindHost !== '0.0.0.0') {
    if (((ipToInt(cfg.bindHost) & mask) >>> 0) !== net) throw new Error(`La interfaz ${cfg.bindHost} no está en la subred del rango (${intToIp(net)}).`);
    return cfg.bindHost;
  }
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && ((ipToInt(a.address) & mask) >>> 0) === net) return a.address;
    }
  }
  throw new Error(`Ninguna interfaz de este equipo tiene una IP en la red ${intToIp(net)}. Asigna una IP fija de esa red a la interfaz conectada a los equipos.`);
}

/** Lógica del servidor, sin red: recibe un paquete y decide la respuesta. */
export class DhcpEngine {
  leases = new Map<string, DhcpLease>();
  /** IP declinadas por un cliente (en uso por otro equipo) hasta la marca de tiempo. */
  private declined = new Map<string, number>();

  constructor(public s: DhcpSettings, private now: () => number = Date.now) {}

  private byIp(ip: string): DhcpLease | undefined {
    for (const l of this.leases.values()) if (l.ip === ip) return l;
    return undefined;
  }

  private inPool(ip: string): boolean {
    const n = ipToInt(ip);
    return n >= this.s.poolStart && n <= this.s.poolEnd;
  }

  private sameNet(ip: string): boolean {
    return ((ipToInt(ip) & this.s.mask) >>> 0) === ((this.s.poolStart & this.s.mask) >>> 0);
  }

  private isFree(ip: string, mac: string): boolean {
    if (ip === this.s.serverIp || ip === this.s.router) return false;
    for (const [m, r] of this.s.reservations) if (r.ip === ip && m !== mac) return false;
    const l = this.byIp(ip);
    if (l && l.mac !== mac && l.expires > this.now()) return false;
    const d = this.declined.get(ip);
    if (d && d > this.now()) return false;
    return true;
  }

  /** Dirección para un cliente: reserva, concesión previa, la que pide o la primera libre. */
  private choose(mac: string, requested?: string): string | null {
    const res = this.s.reservations.get(mac);
    if (res) return res.ip;
    const prev = this.leases.get(mac);
    if (prev && this.inPool(prev.ip) && this.isFree(prev.ip, mac)) return prev.ip;
    if (requested && this.inPool(requested) && this.isFree(requested, mac)) return requested;
    for (let n = this.s.poolStart; n <= this.s.poolEnd; n++) {
      const ip = intToIp(n);
      if (this.isFree(ip, mac)) return ip;
    }
    // Rango lleno: se reutiliza la concesión caducada más antigua.
    let oldest: DhcpLease | undefined;
    for (const l of this.leases.values()) if (l.expires <= this.now() && !this.s.reservations.has(l.mac) && (!oldest || l.expires < oldest.expires)) oldest = l;
    if (oldest) {
      this.leases.delete(oldest.mac);
      return oldest.ip;
    }
    return null;
  }

  private options(type: number, withLease: boolean): Map<number, Buffer> {
    const o = new Map<number, Buffer>();
    o.set(53, Buffer.from([type]));
    o.set(54, ipOpt(this.s.serverIp));
    if (type === MSG.NAK) return o;
    if (withLease) {
      o.set(51, u32(this.s.leaseSecs));
      o.set(58, u32(Math.floor(this.s.leaseSecs / 2)));
      o.set(59, u32(Math.floor(this.s.leaseSecs * 0.875)));
    }
    o.set(1, ipOpt(intToIp(this.s.mask)));
    o.set(28, ipOpt(intToIp(((this.s.poolStart & this.s.mask) | ~this.s.mask) >>> 0)));
    if (this.s.router) o.set(3, ipOpt(this.s.router));
    if (this.s.dns.length) o.set(6, ipOpt(...this.s.dns));
    if (this.s.domain) o.set(15, Buffer.from(this.s.domain, 'latin1'));
    if (this.s.tftpServer) {
      o.set(66, Buffer.from(this.s.tftpServer, 'latin1'));
      // Muchos equipos Cisco usan la opción 150 (lista de IP de TFTP) en vez de la 66.
      if (isIPv4(this.s.tftpServer)) o.set(150, ipOpt(this.s.tftpServer));
    }
    if (this.s.bootFile) o.set(67, Buffer.from(this.s.bootFile, 'latin1'));
    return o;
  }

  private reply(req: DhcpPacket, type: number, yiaddr: string, withLease = true): Buffer {
    return buildPacket({
      op: 2, htype: req.htype, hlen: req.hlen, xid: req.xid, flags: req.flags, giaddr: req.giaddr, chaddr: req.chaddr,
      ciaddr: type === MSG.ACK && req.ciaddr !== '0.0.0.0' ? req.ciaddr : '0.0.0.0', yiaddr,
      siaddr: this.s.tftpServer && isIPv4(this.s.tftpServer) ? this.s.tftpServer : this.s.serverIp,
      file: this.s.bootFile, options: this.options(type, withLease),
    });
  }

  /** Procesa un paquete. Devuelve la respuesta (o null) y una descripción para el registro. */
  handle(req: DhcpPacket): { reply: Buffer | null; type?: number; log?: string; level?: 'info' | 'warn' | 'transfer' } {
    if (req.op !== 1 || req.hlen !== 6) return { reply: null };
    const type = req.options.get(53)?.[0];
    if (!type) return { reply: null };
    const mac = req.chaddr.subarray(0, 6).toString('hex').match(/../g)!.join(':');
    const hostname = req.options.get(12)?.toString('latin1').replace(/[^\x20-\x7e]/g, '') || undefined;
    const reqIp = req.options.get(50)?.length === 4 ? intToIp(req.options.get(50)!.readUInt32BE(0)) : undefined;
    const sid = req.options.get(54)?.length === 4 ? intToIp(req.options.get(54)!.readUInt32BE(0)) : undefined;
    const who = `${mac}${hostname ? ` (${hostname})` : ''}`;
    const now = this.now();

    switch (type) {
      case MSG.DISCOVER: {
        const ip = this.choose(mac, reqIp);
        if (!ip) return { reply: null, log: `Sin direcciones libres para ${who}`, level: 'warn' };
        const prev = this.leases.get(mac);
        if (!prev || prev.ip !== ip || prev.expires <= now) {
          this.leases.set(mac, { mac, ip, hostname, expires: now + OFFER_HOLD_MS, offered: true, reserved: this.s.reservations.has(mac) });
        }
        return { reply: this.reply(req, MSG.OFFER, ip), type: MSG.OFFER, log: `Ofrece ${ip} a ${who}`, level: 'info' };
      }
      case MSG.REQUEST: {
        if (sid && sid !== this.s.serverIp) {
          // El cliente eligió otro servidor: se libera la oferta.
          const l = this.leases.get(mac);
          if (l?.offered) this.leases.delete(mac);
          return { reply: null };
        }
        const wanted = reqIp || (req.ciaddr !== '0.0.0.0' ? req.ciaddr : undefined);
        if (!wanted) return { reply: null };
        const reservation = this.s.reservations.get(mac);
        const ok = reservation ? reservation.ip === wanted : this.inPool(wanted) && this.isFree(wanted, mac);
        if (!ok) {
          // Sólo se niega si la IP pedida es de nuestra red (en otra red no somos autoridad)
          // o si el cliente nos eligió explícitamente.
          if (!sid && !this.sameNet(wanted)) return { reply: null };
          return { reply: this.reply(req, MSG.NAK, '0.0.0.0', false), type: MSG.NAK, log: `Rechaza ${wanted} para ${who}`, level: 'warn' };
        }
        const lease: DhcpLease = { mac, ip: wanted, hostname: hostname || this.leases.get(mac)?.hostname, expires: now + this.s.leaseSecs * 1000, reserved: !!reservation };
        const renewal = this.leases.get(mac)?.ip === wanted && !this.leases.get(mac)?.offered;
        this.leases.set(mac, lease);
        const name = `${mac}${lease.hostname ? ` (${lease.hostname})` : ''}`;
        return { reply: this.reply(req, MSG.ACK, wanted), type: MSG.ACK, log: `${renewal ? 'Renueva' : 'Concede'} ${wanted} a ${name}${reservation ? ' (reserva)' : ''}`, level: 'transfer' };
      }
      case MSG.DECLINE: {
        if (reqIp) {
          this.declined.set(reqIp, now + this.s.leaseSecs * 1000);
          if (this.leases.get(mac)?.ip === reqIp) this.leases.delete(mac);
        }
        return { reply: null, log: `${who} rechazó ${reqIp ?? '?'}: la IP ya está en uso en la red`, level: 'warn' };
      }
      case MSG.RELEASE: {
        const l = this.leases.get(mac);
        if (l && l.ip === req.ciaddr) this.leases.delete(mac);
        return { reply: null, log: `${who} liberó ${req.ciaddr}`, level: 'info' };
      }
      case MSG.INFORM:
        return { reply: this.reply(req, MSG.ACK, '0.0.0.0', false), type: MSG.ACK, log: `Envía la configuración a ${req.ciaddr} (${mac})`, level: 'info' };
    }
    return { reply: null };
  }

  /** Concesiones vigentes (también las reservas sin concesión), ordenadas por IP. */
  list(): DhcpLease[] {
    const now = this.now();
    const out = [...this.leases.values()].filter((l) => l.expires > now);
    for (const [mac, r] of this.s.reservations) if (!out.some((l) => l.mac === mac)) out.push({ mac, ip: r.ip, hostname: r.name, expires: 0, reserved: true });
    return out.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  }
}

export class DhcpServer extends BuiltinServer {
  private socks: Socket[] = [];
  private engine: DhcpEngine | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Puerto al que se responde (68 salvo en las pruebas). */
  clientPort = 68;

  boundPort(): number | undefined {
    try {
      return this.socks[0]?.address().port;
    } catch {
      return undefined;
    }
  }

  details(): Partial<ServerStatus> {
    return this.engine ? { leases: this.engine.list() } : {};
  }

  private get leaseFile(): string {
    return join(this.cfg.rootDir, 'concesiones-dhcp.json');
  }

  private bind(address: string, reuse: boolean): Promise<Socket> {
    const sock = createSocket({ type: 'udp4', reuseAddr: reuse });
    return new Promise((resolve, reject) => {
      sock.once('error', (e) => reject(new Error(friendlyListenError(e as NodeJS.ErrnoException, this.cfg.port))));
      sock.bind(this.cfg.port, address, () => {
        sock.setBroadcast(true);
        resolve(sock);
      });
    });
  }

  async start(): Promise<void> {
    const serverIp = pickServerIp(this.cfg);
    const settings = dhcpSettings(this.cfg, serverIp);
    await fs.mkdir(this.cfg.rootDir, { recursive: true });
    const engine = new DhcpEngine(settings);
    try {
      const saved = JSON.parse(await fs.readFile(this.leaseFile, 'utf8')) as DhcpLease[];
      for (const l of saved) if (l.expires > Date.now() && !l.offered) engine.leases.set(l.mac, l);
    } catch {
      /* sin concesiones previas */
    }
    // Los clientes sin IP envían a 255.255.255.255: en Linux/macOS sólo un socket en 0.0.0.0 los
    // recibe, y otro ligado a la IP del servidor hace que las respuestas salgan por esa interfaz.
    // En Windows basta con ligarse a la IP de la interfaz.
    const loopback = serverIp.startsWith('127.');
    if (process.platform === 'win32' || loopback) this.socks = [await this.bind(process.platform === 'win32' ? serverIp : '0.0.0.0', false)];
    else {
      const any = await this.bind('0.0.0.0', true);
      try {
        this.socks = [any, await this.bind(serverIp, true)];
      } catch {
        this.socks = [any];
      }
    }
    for (const s of this.socks) {
      s.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      s.on('error', (e) => this.log('error', e.message));
    }
    this.engine = engine;
    this.running = true;
    const span = `${intToIp(settings.poolStart)}–${intToIp(settings.poolEnd)}`;
    this.log('info', `DHCP escuchando en ${serverIp}:${this.boundPort()} · rango ${span} · máscara ${intToIp(settings.mask)}${settings.router ? ` · puerta de enlace ${settings.router}` : ''}${settings.tftpServer ? ` · TFTP ${settings.tftpServer}` : ''}${settings.reservations.size ? ` · ${settings.reservations.size} reserva(s)` : ''}`);
    this.changed();
  }

  async stop(): Promise<void> {
    await Promise.all(this.socks.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.socks = [];
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.persist();
    this.engine = null;
    this.running = false;
    this.log('info', 'DHCP detenido');
    this.changed();
  }

  private async persist(): Promise<void> {
    this.saveTimer = null;
    if (!this.engine) return;
    const list = [...this.engine.leases.values()].filter((l) => !l.offered && l.expires > Date.now());
    await fs.writeFile(this.leaseFile, JSON.stringify(list, null, 2)).catch((e) => this.log('error', `No se pudieron guardar las concesiones: ${(e as Error).message}`));
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    const engine = this.engine;
    if (!engine) return;
    const req = parsePacket(msg);
    if (!req) return;
    const r = engine.handle(req);
    if (r.log) this.log(r.level || 'info', r.log);
    if (r.type === MSG.ACK || req.options.get(53)?.[0] === MSG.RELEASE || req.options.get(53)?.[0] === MSG.DECLINE) {
      this.changed();
      if (!this.saveTimer) this.saveTimer = setTimeout(() => void this.persist(), 1000);
    }
    if (!r.reply) return;
    // Destino según RFC 2131 §4.1: relé, cliente con IP o difusión.
    const sock = this.socks[this.socks.length - 1];
    let addr = '255.255.255.255';
    let port = this.clientPort;
    if (req.giaddr !== '0.0.0.0') {
      addr = req.giaddr;
      port = this.cfg.port;
    } else if (req.ciaddr !== '0.0.0.0' && r.type !== MSG.NAK) addr = req.ciaddr;
    else if (rinfo.address.startsWith('127.')) addr = rinfo.address; // pruebas locales
    sock.send(r.reply, port, addr, (e) => e && this.log('error', `No se pudo enviar ${MSG_NAME[r.type!]}: ${e.message}`));
  }
}
