// Base común de los servidores integrados.
import { EventEmitter } from 'node:events';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig, ServerLogEntry, ServerStatus } from '../../shared/types';

export abstract class BuiltinServer extends EventEmitter {
  running = false;
  active = 0;
  error?: string;

  /**
   * @param stateDir carpeta privada de la app donde se guardan claves de host y certificados
   *                 generados (nunca dentro de la carpeta compartida).
   */
  constructor(public cfg: ServerConfig, readonly stateDir = join(homedir(), 'NexusNeo', '.estado')) {
    super();
  }

  /** Datos extra para el estado que ve la interfaz (p. ej. concesiones DHCP). */
  details(): Partial<ServerStatus> {
    return {};
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Puerto real en escucha (útil cuando se configura 0). */
  abstract boundPort(): number | undefined;

  protected log(level: ServerLogEntry['level'], message: string, extra: Partial<ServerLogEntry> = {}): void {
    const entry: ServerLogEntry = { serverId: this.cfg.id, time: Date.now(), level, message, ...extra };
    this.emit('log', entry);
  }

  protected changed(): void {
    this.emit('status');
  }

  protected track<T>(p: Promise<T>): Promise<T> {
    this.active++;
    this.changed();
    return p.finally(() => {
      this.active--;
      this.changed();
    });
  }
}

/**
 * Resuelve una ruta pedida por un cliente dentro de la carpeta raíz.
 * Devuelve null si intenta salir de ella (path traversal).
 */
export function safeResolve(root: string, requested: string): string | null {
  const clean = requested.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = resolve(root, clean);
  const rel = relative(resolve(root), full);
  if (rel === '') return full;
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return null;
  return full;
}

export function friendlyListenError(e: NodeJS.ErrnoException, port: number): string {
  if (e.code === 'EACCES') {
    return `Sin permiso para usar el puerto ${port}. En Linux los puertos < 1024 requieren privilegios: usa otro puerto (p. ej. ${port + 1000 * (port < 100 ? 10 : 1)}) o concede el permiso con "sudo setcap 'cap_net_bind_service=+ep'" al ejecutable.`;
  }
  if (e.code === 'EADDRINUSE') return `El puerto ${port} ya está en uso por otra aplicación.`;
  if (e.code === 'EADDRNOTAVAIL') return 'La dirección de escucha no existe en este equipo.';
  return e.message;
}
