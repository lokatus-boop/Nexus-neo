// Lanzador de clientes externos para RDP y VNC (MVP; el visor integrado está en la hoja de ruta).
import { spawn } from 'node:child_process';
import type { SessionConfig, Settings } from '../../shared/types';

export interface ExternalCommand {
  command: string;
  args: string[];
}

export function buildExternalCommand(cfg: SessionConfig, settings: Settings, platform = process.platform): ExternalCommand {
  const host = cfg.host || 'localhost';
  if (cfg.kind === 'rdp') {
    const port = cfg.port || 3389;
    if (settings.rdpClient) return { command: settings.rdpClient, args: [`/v:${host}:${port}`] };
    if (platform === 'win32') {
      const args = [`/v:${host}:${port}`];
      if (cfg.rdpFullscreen) args.push('/f');
      return { command: 'mstsc.exe', args };
    }
    const args = [`/v:${host}:${port}`, '/cert:tofu', '+clipboard', '/dynamic-resolution'];
    if (cfg.username) args.push(`/u:${cfg.username}`);
    if (cfg.rdpFullscreen) args.push('/f');
    else if (cfg.rdpResolution) args.push(`/size:${cfg.rdpResolution}`);
    return { command: 'xfreerdp', args };
  }
  if (cfg.kind === 'vnc') {
    const port = cfg.port || 5900;
    return { command: settings.vncClient || 'vncviewer', args: [`${host}::${port}`] };
  }
  throw new Error(`Tipo de sesión no externo: ${cfg.kind}`);
}

export function launchExternal(cfg: SessionConfig, settings: Settings): Promise<void> {
  const { command, args } = buildExternalCommand(cfg, settings);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (e) =>
      reject(new Error(`No se pudo iniciar "${command}": ${e.message}. Instálalo o configura su ruta en Ajustes.`)),
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
