// Switch de pruebas con una CLI al estilo Cisco IOS, accesible por SSH (con «scp -t») y por
// Telnet. Simula prompt, eco, modo enable, paginador --More--, modo configuración, preguntas
// de confirmación y errores «% Invalid input».
import { Server, Connection, ServerChannel } from 'ssh2';
import { createServer, AddressInfo, Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairChecked } from '../../src/main/keys';

export interface SwitchState {
  hostname: string;
  config: string[];
  enableSecret: string;
  /** Archivos recibidos por SCP: nombre → contenido. */
  flash: Map<string, Buffer>;
  /** Órdenes recibidas (para comprobar en las pruebas). */
  history: string[];
}

export function newSwitchState(hostname: string): SwitchState {
  return {
    hostname,
    enableSecret: 'cisco',
    config: ['version 15.2', 'service timestamps log datetime', `hostname ${hostname}`, '!', ...Array.from({ length: 30 }, (_, i) => `interface GigabitEthernet0/${i + 1}\n switchport mode access\n!`).join('\n').split('\n'), 'line vty 0 4', ' transport input ssh', 'end'],
    flash: new Map(),
    history: [],
  };
}

interface Out {
  write(s: string): void;
  close(): void;
}

/** Motor de la CLI: recibe bytes del cliente y responde como lo haría el equipo. */
class SwitchCli {
  private mode: 'user' | 'enable' | 'config' | 'config-if' = 'user';
  private line = '';
  private pager = true;
  private pending: string[] | null = null;
  private ask: ((answer: string) => void) | null = null;
  private askPassword: ((pw: string) => void) | null = null;

  constructor(private readonly s: SwitchState, private readonly out: Out, startEnabled = false) {
    if (startEnabled) this.mode = 'enable';
  }

  private get prompt(): string {
    return `${this.s.hostname}${this.mode === 'user' ? '>' : this.mode === 'enable' ? '#' : this.mode === 'config' ? '(config)#' : '(config-if)#'}`;
  }

  start(): void {
    this.out.write(`\r\n${this.s.hostname} - equipo de pruebas\r\n\r\n${this.prompt}`);
  }

  feed(data: string): void {
    for (const ch of data) {
      if (this.pending) {
        // Paginador: espacio = siguiente página, q = cortar.
        this.out.write('\r        \r');
        if (ch === 'q') this.pending = [];
        this.page();
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && this.line === '' && this.lastWasCr) continue;
        this.lastWasCr = ch === '\r';
        const l = this.line;
        this.line = '';
        if (this.askPassword) {
          this.out.write('\r\n');
          const f = this.askPassword;
          this.askPassword = null;
          f(l);
          continue;
        }
        this.out.write('\r\n');
        if (this.ask) {
          const f = this.ask;
          this.ask = null;
          f(l);
          continue;
        }
        this.exec(l.trim());
        continue;
      }
      this.lastWasCr = false;
      this.line += ch;
      if (!this.askPassword) this.out.write(ch);
    }
  }

  private lastWasCr = false;

  private print(lines: string[]): void {
    if (!this.pager || lines.length <= 20) {
      this.out.write(lines.join('\r\n') + (lines.length ? '\r\n' : '') + this.prompt);
      return;
    }
    this.pending = [...lines];
    this.page();
  }

  private page(): void {
    const chunk = this.pending!.splice(0, 20);
    if (chunk.length) this.out.write(chunk.join('\r\n') + '\r\n');
    if (this.pending!.length) this.out.write(' --More-- ');
    else {
      this.pending = null;
      this.out.write(this.prompt);
    }
  }

  private invalid(): void {
    this.out.write(`                ^\r\n% Invalid input detected at '^' marker.\r\n\r\n${this.prompt}`);
  }

  private exec(cmd: string): void {
    if (cmd) this.s.history.push(cmd);
    if (!cmd) return this.out.write(this.prompt);
    if (cmd === 'exit' || cmd === 'logout') {
      if (this.mode === 'config-if') this.mode = 'config';
      else if (this.mode === 'config') this.mode = 'enable';
      else return this.out.close();
      return this.out.write(this.prompt);
    }
    if (this.mode === 'config' || this.mode === 'config-if') {
      if (cmd === 'end') {
        this.mode = 'enable';
        return this.out.write(this.prompt);
      }
      if (/^bogus/.test(cmd)) return this.invalid();
      const m = /^hostname (\S+)$/.exec(cmd);
      if (m) {
        this.s.config = this.s.config.map((l) => (l.startsWith('hostname ') ? `hostname ${m[1]}` : l));
        this.s.hostname = m[1];
      } else {
        if (/^interface /.test(cmd)) this.mode = 'config-if';
        this.s.config.splice(this.s.config.length - 1, 0, this.mode === 'config-if' && !/^interface /.test(cmd) ? ` ${cmd}` : cmd);
      }
      return this.out.write(this.prompt);
    }
    if (cmd === 'enable') {
      if (this.mode !== 'user') return this.out.write(this.prompt);
      this.out.write('Password: ');
      this.askPassword = (pw) => {
        if (pw === this.s.enableSecret) this.mode = 'enable';
        else this.out.write('% Access denied\r\n\r\n');
        this.out.write(this.prompt);
      };
      return;
    }
    if (cmd === 'terminal length 0') {
      this.pager = false;
      return this.out.write(this.prompt);
    }
    if (cmd === 'terminal width 0') return this.out.write(this.prompt);
    if (cmd === 'show version') return this.print([`Cisco IOS Software, ${this.s.hostname} de pruebas, Version 15.2(7)E`, `${this.s.hostname} uptime is 1 week`]);
    if (cmd === 'show clock') return this.print([`*10:00:00.000 UTC ${new Date().toDateString()}`]);
    if (cmd === 'show flash:') return this.print([...[...this.s.flash].map(([n, b]) => `  ${b.length}  ${n}`), `${this.s.flash.size} files`]);
    if (cmd === 'slow') {
      setTimeout(() => this.print(['lento']), 3000);
      return;
    }
    if (cmd === 'show running-config') {
      if (this.mode === 'user') return this.invalid();
      return this.print(['Building configuration...', '', `Current configuration : ${this.s.config.join('\n').length} bytes`, '!', `! Last configuration change at ${new Date().toISOString()}`, '!', ...this.s.config]);
    }
    if (cmd === 'write memory') return this.print(['Building configuration...', '[OK]']);
    if (cmd === 'configure terminal') {
      if (this.mode === 'user') return this.invalid();
      this.mode = 'config';
      return this.out.write('Enter configuration commands, one per line.  End with CNTL/Z.\r\n' + this.prompt);
    }
    const del = /^delete flash:(\S*)$/.exec(cmd);
    if (del) {
      this.out.write(`Delete filename [${del[1]}]? `);
      this.ask = (a) => {
        const name = a.trim() || del[1];
        this.out.write(`Delete flash:/${name}? [confirm]`);
        this.ask = (c) => {
          if (c.trim() === '' || /^y/i.test(c)) this.s.flash.delete(name);
          this.out.write(this.prompt);
        };
      };
      return;
    }
    return this.invalid();
  }
}

/** Receptor SCP («scp -t destino») que guarda los archivos en state.flash. */
function scpSink(ch: ServerChannel, s: SwitchState, target: string): void {
  const dest = target.replace(/^'|'$/g, '');
  let buf = Buffer.alloc(0);
  let expect: { name: string; size: number } | null = null;
  ch.write(Buffer.from([0]));
  ch.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!expect) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        buf = buf.subarray(nl + 1);
        const m = /^C(\d{4}) (\d+) (.+)$/.exec(header);
        if (!m) {
          ch.write(Buffer.concat([Buffer.from([2]), Buffer.from('cabecera no válida\n')]));
          return ch.close();
        }
        expect = { name: m[3], size: Number(m[2]) };
        ch.write(Buffer.from([0]));
        continue;
      }
      if (buf.length < expect.size + 1) return;
      const content = buf.subarray(0, expect.size);
      buf = buf.subarray(expect.size + 1);
      const base = /[/:]$/.test(dest) ? expect.name : dest.replace(/^.*[/:]/, '');
      s.flash.set(base, Buffer.from(content));
      expect = null;
      ch.write(Buffer.from([0]));
      ch.exit(0);
      ch.end();
      return;
    }
  });
}

export interface FakeSwitch {
  sshPort: number;
  telnetPort: number;
  state: SwitchState;
  /** Cambia la clave de host SSH (para probar huellas cambiadas). */
  rotateHostKey(): void;
  close(): Promise<void>;
}

export async function startFakeSwitch(hostname: string, creds = { user: 'admin', pass: 'switchpass' }): Promise<FakeSwitch> {
  const state = newSwitchState(hostname);
  let hostKey = generateKeyPairChecked('ed25519');
  const servers: Server[] = [];
  const conns = new Set<Connection>();
  const makeSsh = () =>
    new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
      conns.add(client);
      client.on('error', () => undefined);
      client.on('close', () => conns.delete(client));
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === creds.user && ctx.password === creds.pass) return ctx.accept();
        ctx.reject(['password']);
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (accept) => accept?.());
          session.on('window-change', (accept) => accept?.());
          session.on('shell', (accept) => {
            const ch = accept();
            const cli = new SwitchCli(state, { write: (t) => ch.write(t), close: () => { ch.exit(0); ch.close(); } });
            ch.on('data', (d: Buffer) => cli.feed(d.toString('utf8')));
            cli.start();
          });
          session.on('exec', (accept, _reject, info) => {
            const ch = accept();
            const m = /^scp -t (.+)$/.exec(info.command);
            if (m) return scpSink(ch, state, m[1]);
            ch.stderr.write('Line has invalid autocommand\n');
            ch.exit(1);
            ch.end();
          });
        });
      });
    });
  let ssh = makeSsh();
  const sshPort = await new Promise<number>((r) => ssh.listen(0, '127.0.0.1', () => r((ssh.address() as AddressInfo).port)));
  servers.push(ssh);

  const sockets = new Set<Socket>();
  const telnet = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // Negocia eco del servidor (IAC WILL ECHO, IAC WILL SGA), como los equipos reales.
    sock.write(Buffer.from([255, 251, 1, 255, 251, 3]));
    sock.write('\r\nUser Access Verification\r\n\r\nUsername: ');
    let stage: 'user' | 'pass' | 'cli' = 'user';
    let line = '';
    let user = '';
    let cli: SwitchCli | null = null;
    sock.on('data', (raw: Buffer) => {
      // Quita las órdenes IAC del cliente.
      const bytes: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === 255) {
          const cmd = raw[i + 1];
          if (cmd === 250) {
            while (i < raw.length && !(raw[i] === 255 && raw[i + 1] === 240)) i++;
            i++;
          } else i += cmd >= 251 ? 2 : 1;
          continue;
        }
        bytes.push(raw[i]);
      }
      const text = Buffer.from(bytes).toString('utf8');
      if (stage === 'cli') return cli!.feed(text);
      for (const ch of text) {
        if (ch === '\n' || ch === '\0') continue;
        if (ch !== '\r') {
          line += ch;
          if (stage === 'user') sock.write(ch);
          continue;
        }
        sock.write('\r\n');
        if (stage === 'user') {
          user = line;
          stage = 'pass';
          sock.write('Password: ');
        } else if (user === creds.user && line === creds.pass) {
          stage = 'cli';
          cli = new SwitchCli(state, { write: (t) => sock.write(t), close: () => sock.end() });
          cli.start();
        } else {
          stage = 'user';
          sock.write('% Login invalid\r\n\r\nUsername: ');
        }
        line = '';
      }
    });
  });
  const telnetPort = await new Promise<number>((r) => telnet.listen(0, '127.0.0.1', () => r((telnet.address() as AddressInfo).port)));

  return {
    sshPort,
    telnetPort,
    state,
    rotateHostKey() {
      hostKey = generateKeyPairChecked('ed25519');
      const old = ssh;
      for (const c of conns) c.end();
      old.close();
      ssh = makeSsh();
      ssh.listen(sshPort, '127.0.0.1');
      servers.push(ssh);
    },
    async close() {
      for (const c of conns) c.end();
      for (const s of sockets) s.destroy();
      await Promise.all([...servers.map((s) => new Promise<void>((r) => s.close(() => r()))), new Promise<void>((r) => telnet.close(() => r()))]);
    },
  };
}

/** Guarda un archivo temporal para las subidas. */
export async function tempFile(dir: string, name: string, content: string | Buffer): Promise<string> {
  const p = join(dir, name);
  await fs.writeFile(p, content);
  return p;
}
