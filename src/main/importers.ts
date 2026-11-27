// Importadores de sesiones desde otros formatos (función pura, probada en test/).
import { randomUUID } from 'node:crypto';
import type { SessionConfig } from '../shared/types';

/**
 * Importa entradas de un archivo ~/.ssh/config.
 * Soporta Host, HostName, User, Port, IdentityFile, ProxyJump (primer salto,
 * resuelto contra otros Host del mismo archivo), ForwardX11 y LocalForward/RemoteForward/DynamicForward.
 */
export function parseSshConfig(text: string, folder = 'Importadas/ssh_config'): SessionConfig[] {
  const blocks: { alias: string; opts: [string, string][] }[] = [];
  let current: { alias: string; opts: [string, string][] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = null;
      // Ignora patrones con comodines.
      for (const alias of value.split(/\s+/)) {
        if (/[*?!]/.test(alias)) continue;
        current = { alias, opts: [] };
        blocks.push(current);
        break;
      }
    } else if (key === 'match') {
      current = null;
    } else if (current) {
      current.opts.push([key, value]);
    }
  }

  const byAlias = new Map<string, SessionConfig>();
  const jumps: [SessionConfig, string][] = [];
  for (const b of blocks) {
    const s: SessionConfig = { id: randomUUID(), name: b.alias, folder, kind: 'ssh', host: b.alias, port: 22, auth: 'password', tunnels: [] };
    for (const [k, v] of b.opts) {
      if (k === 'hostname') s.host = v;
      else if (k === 'user') s.username = v;
      else if (k === 'port') s.port = Number(v) || 22;
      else if (k === 'identityfile') {
        s.auth = 'key';
        s.keyPath = v;
      } else if (k === 'proxyjump') jumps.push([s, v.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '')]);
      else if (k === 'forwardx11') s.x11 = /^yes$/i.test(v);
      else if (k === 'localforward' || k === 'remoteforward') {
        const [bind, dest] = v.split(/\s+/);
        const [bh, bp] = bind.includes(':') ? bind.split(':') : ['127.0.0.1', bind];
        const [dh, dp] = (dest || '').split(':');
        s.tunnels!.push({
          id: randomUUID(),
          name: '',
          type: k === 'localforward' ? 'local' : 'remote',
          bindHost: bh,
          bindPort: Number(bp),
          destHost: dh,
          destPort: Number(dp),
          autoStart: true,
        });
      } else if (k === 'dynamicforward') {
        const [bh, bp] = v.includes(':') ? v.split(':') : ['127.0.0.1', v];
        s.tunnels!.push({ id: randomUUID(), name: '', type: 'dynamic', bindHost: bh, bindPort: Number(bp), destHost: '', destPort: 0, autoStart: true });
      }
    }
    byAlias.set(b.alias, s);
  }
  for (const [s, alias] of jumps) {
    const j = byAlias.get(alias);
    if (j) s.jumpSessionId = j.id;
  }
  return [...byAlias.values()];
}

/** Importa el formato de exportación propio de Nexus Neo. */
export function parseNexusExport(text: string): SessionConfig[] {
  const data = JSON.parse(text) as { format?: string; sessions?: SessionConfig[] };
  if (data.format !== 'nexus-neo-sessions' || !Array.isArray(data.sessions)) {
    throw new Error('El archivo no es una exportación de Nexus Neo.');
  }
  // Reasigna ids conservando referencias de salto.
  const map = new Map<string, string>();
  for (const s of data.sessions) map.set(s.id, randomUUID());
  return data.sessions.map((s) => ({
    ...s,
    id: map.get(s.id)!,
    jumpSessionId: s.jumpSessionId ? map.get(s.jumpSessionId) : undefined,
  }));
}

export function buildNexusExport(sessions: SessionConfig[]): string {
  return JSON.stringify({ format: 'nexus-neo-sessions', version: 1, exportedAt: new Date().toISOString(), sessions }, null, 2);
}
