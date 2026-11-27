import type { SessionConfig, SessionKind } from '../shared/types';

export const DEFAULT_PORTS: Partial<Record<SessionKind, number>> = { ssh: 22, mosh: 22, telnet: 23, rdp: 3389, vnc: 5900 };

/** Interpreta "usuario@host:puerto" para la conexión rápida. */
export function parseQuickConnect(text: string): Partial<SessionConfig> | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(?:(ssh|mosh|telnet|rdp|vnc):\/\/)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s/]+)(?::(\d+))?\/?$/i.exec(t);
  if (!m) return null;
  const kind = ((m[1] || 'ssh').toLowerCase()) as SessionKind;
  return {
    kind,
    username: m[2],
    host: m[3].replace(/^\[|\]$/g, ''),
    port: m[4] ? Number(m[4]) : DEFAULT_PORTS[kind],
    auth: 'password',
    name: t,
    autoSftp: true,
  };
}
