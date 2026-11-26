import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TerminalConnection } from './base';
import type { SessionConfig } from '../../shared/types';

type Pty = import('node-pty').IPty;

export interface ShellProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
}

/** Detecta los shells disponibles en el sistema. */
export function detectShells(): ShellProfile[] {
  const out: ShellProfile[] = [];
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const candidates: ShellProfile[] = [
      { id: 'pwsh', name: 'PowerShell 7', command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] },
      { id: 'powershell', name: 'Windows PowerShell', command: join(sys, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'), args: ['-NoLogo'] },
      { id: 'cmd', name: 'Símbolo del sistema', command: join(sys, 'System32\\cmd.exe'), args: [] },
      { id: 'wsl', name: 'WSL', command: join(sys, 'System32\\wsl.exe'), args: [] },
      { id: 'gitbash', name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
    ];
    for (const c of candidates) if (existsSync(c.command)) out.push(c);
  } else {
    const seen = new Set<string>();
    const add = (cmd: string) => {
      if (seen.has(cmd) || !existsSync(cmd)) return;
      seen.add(cmd);
      const base = cmd.split('/').pop()!;
      out.push({ id: base + (seen.size > 1 ? `-${seen.size}` : ''), name: `${base} (${cmd})`, command: cmd, args: ['-l'] });
    };
    if (process.env.SHELL) add(process.env.SHELL);
    try {
      for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
        const l = line.trim();
        if (l && !l.startsWith('#') && !/nologin|false/.test(l)) add(l);
      }
    } catch {
      /* /etc/shells no existe */
    }
    add('/bin/bash');
    add('/bin/sh');
  }
  return out;
}

export function defaultShell(preferred?: string): ShellProfile {
  const shells = detectShells();
  return (
    shells.find((s) => s.id === preferred || s.command === preferred) ||
    shells[0] || { id: 'sh', name: 'sh', command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: [] }
  );
}

export class LocalConnection extends TerminalConnection {
  private pty: Pty | null = null;

  constructor(private readonly cfg: SessionConfig, private readonly fallbackShell?: string) {
    super();
  }

  async open(cols: number, rows: number): Promise<void> {
    const ptyMod = require('node-pty') as typeof import('node-pty');
    let command: string;
    let args: string[];
    if (this.cfg.shell) {
      const profile = detectShells().find((s) => s.id === this.cfg.shell);
      command = profile?.command || this.cfg.shell;
      args = this.cfg.shellArgs ?? profile?.args ?? [];
    } else {
      const sh = defaultShell(this.fallbackShell);
      command = sh.command;
      args = this.cfg.shellArgs ?? sh.args;
    }
    const cwd = this.cfg.cwd && existsSync(this.cfg.cwd) ? this.cfg.cwd : homedir();
    this.pty = ptyMod.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'NexusNeo' } as Record<string, string>,
    });
    this.pty.onData((d) => this.emitData(d));
    this.pty.onExit(({ exitCode }) => {
      this.setState('closed', `El proceso terminó con código ${exitCode}`);
      this.emit('exit', exitCode);
    });
    this.setState('connected');
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      /* el proceso ya terminó */
    }
  }

  close(): void {
    try {
      this.pty?.kill();
    } catch {
      /* ya terminado */
    }
    this.pty = null;
  }
}
