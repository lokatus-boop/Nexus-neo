// Respaldo de configuraciones de equipos de red: se conecta a cada equipo, desactiva la
// paginación, lee la configuración con la orden del fabricante y la guarda con fecha. Sólo se
// guarda un archivo nuevo cuando la configuración ha cambiado (sin contar líneas volátiles).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { JobRunner, RunnerDeps, stamp, DeviceConnection } from './runner';
import { safeName } from '../../shared/template';
import type { BackupEntry, BackupJob, DeviceRunResult, JobProgress, NetDevice } from '../../shared/types';

export interface VendorProfile {
  id: string;
  label: string;
  /** Órdenes previas (paginación, ancho…). Sus errores se ignoran. */
  setup: string[];
  /** Orden que muestra la configuración. */
  command: string;
  /** Líneas que cambian solas y no cuentan como cambio de configuración. */
  volatile?: RegExp[];
}

const CISCO_VOLATILE = [/^Building configuration/i, /^Current configuration ?:/i, /^! (Last configuration change|NVRAM config last updated)/i, /^ntp clock-period/i, /^Time source is/i];

export const VENDORS: VendorProfile[] = [
  { id: 'cisco-ios', label: 'Cisco IOS / IOS-XE', setup: ['terminal length 0', 'terminal width 0'], command: 'show running-config', volatile: CISCO_VOLATILE },
  { id: 'cisco-nxos', label: 'Cisco NX-OS', setup: ['terminal length 0'], command: 'show running-config', volatile: [...CISCO_VOLATILE, /^!Time:/i, /^!Running configuration last done at/i] },
  { id: 'cisco-asa', label: 'Cisco ASA', setup: ['terminal pager 0'], command: 'show running-config', volatile: [/^: Saved/i, /^: Written by/i, /^Cryptochecksum/i] },
  { id: 'aruba-cx', label: 'Aruba AOS-CX', setup: ['no page'], command: 'show running-config', volatile: [/^Current configuration:/i] },
  { id: 'hpe-procurve', label: 'HPE ProCurve / Aruba AOS-S', setup: ['no page'], command: 'show running-config', volatile: [/^Running configuration:/i] },
  { id: 'hpe-comware', label: 'HPE Comware / H3C', setup: ['screen-length disable'], command: 'display current-configuration' },
  { id: 'huawei', label: 'Huawei VRP', setup: ['screen-length 0 temporary'], command: 'display current-configuration', volatile: [/^!Software Version/i, /^!Last configuration was/i] },
  { id: 'juniper', label: 'Juniper Junos', setup: ['set cli screen-length 0', 'set cli screen-width 0'], command: 'show configuration | display set', volatile: [/^## Last commit/i, /^## Last changed/i] },
  { id: 'mikrotik', label: 'MikroTik RouterOS', setup: [], command: '/export terse', volatile: [/^# \w{3}\/\d{2}\/\d{4} \d\d:\d\d:\d\d by RouterOS/i, /^# \d{4}-\d\d-\d\d \d\d:\d\d:\d\d by RouterOS/i] },
  { id: 'fortigate', label: 'Fortinet FortiGate', setup: [], command: 'show full-configuration', volatile: [/^#conf_file_ver=/i] },
  { id: 'paloalto', label: 'Palo Alto PAN-OS', setup: ['set cli pager off', 'set cli config-output-format set'], command: 'show config running' },
  { id: 'dell-os10', label: 'Dell OS10', setup: ['terminal length 0'], command: 'show running-configuration' },
  { id: 'linux', label: 'Linux / genérico (orden propia)', setup: [], command: 'cat /etc/network/interfaces' },
];

export function vendorById(id?: string): VendorProfile {
  return VENDORS.find((v) => v.id === id) || VENDORS[0];
}

/** Configuración sin líneas volátiles, para decidir si ha cambiado. */
export function normalizeConfig(text: string, vendor: VendorProfile): string {
  const vol = vendor.volatile || [];
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !vol.some((re) => re.test(l.trim())))
    .join('\n')
    .trim();
}

const FILE_RE = /^(\d{4}-\d\d-\d\d_\d{6})\.cfg$/;

/** Respaldos guardados de un equipo, del más reciente al más antiguo. */
export async function listDeviceBackups(baseDir: string, deviceName: string): Promise<BackupEntry[]> {
  const dir = join(baseDir, safeName(deviceName));
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: BackupEntry[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const st = await fs.stat(join(dir, f)).catch(() => null);
    if (!st) continue;
    const [d, t] = m[1].split('_');
    const time = new Date(`${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`).getTime();
    out.push({ device: deviceName, file: join(dir, f), time, size: st.size });
  }
  return out.sort((a, b) => b.time - a.time);
}

/** Todos los equipos con respaldos (carpeta → número de copias y la más reciente). */
export async function listAllBackups(baseDir: string): Promise<{ device: string; count: number; last: number }[]> {
  const dirs = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const out: { device: string; count: number; last: number }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const list = await listDeviceBackups(baseDir, d.name);
    if (list.length) out.push({ device: d.name, count: list.length, last: list[0].time });
  }
  return out.sort((a, b) => a.device.localeCompare(b.device));
}

/** Quita de la salida el eco, avisos y restos de prompt que no forman parte de la configuración. */
export function cleanConfig(out: string): string {
  return out.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

export async function backupDevice(conn: DeviceConnection, r: DeviceRunResult, baseDir: string, override?: string, timeoutMs?: number): Promise<void> {
  const dev: NetDevice = conn.device;
  const vendor = vendorById(dev.vendor);
  for (const s of vendor.setup) {
    conn.log(`> ${s}`);
    await conn.cli.run(s, timeoutMs).catch(() => '');
  }
  const command = override?.trim() || vendor.command;
  conn.log(`> ${command}`);
  const out = await conn.cli.run(command, timeoutMs);
  if (/^\s*% ?(Invalid|Incomplete|Unknown|Ambiguous)|Unrecognized command|syntax error|command not found/im.test(out.split('\n').slice(0, 3).join('\n'))) {
    throw new Error(`El equipo no reconoce «${command}». Elige otro perfil de fabricante o indica la orden.`);
  }
  const config = cleanConfig(out);
  if (config.trim().length < 10) throw new Error('El equipo devolvió una configuración vacía.');
  const prev = (await listDeviceBackups(baseDir, dev.name || dev.host))[0];
  const prevText = prev ? await fs.readFile(prev.file, 'utf8').catch(() => '') : '';
  const changed = !prev || normalizeConfig(prevText, vendor) !== normalizeConfig(config, vendor);
  r.changed = changed;
  if (changed) {
    const dir = join(baseDir, safeName(dev.name || dev.host));
    await fs.mkdir(dir, { recursive: true });
    r.backupFile = join(dir, `${stamp()}.cfg`);
    await fs.writeFile(r.backupFile, config);
    conn.log(prev ? `Configuración cambiada: guardada en ${r.backupFile}` : `Primer respaldo guardado en ${r.backupFile}`);
    r.message = prev ? 'Cambiada' : 'Primer respaldo';
  } else {
    r.backupFile = prev!.file;
    conn.log(`Sin cambios desde ${new Date(prev!.time).toLocaleString()}.`);
    r.message = 'Sin cambios';
  }
}

export function runBackup(job: BackupJob, deps: RunnerDeps, baseDir: string, onProgress: (p: JobProgress) => void): { runner: JobRunner; done: Promise<JobProgress> } {
  if (!job.devices.length) throw new Error('Elige al menos un equipo.');
  const outDir = join(baseDir, '_ejecuciones', `${stamp()}_${job.name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'respaldo'}`);
  const runner = new JobRunner({
    kind: 'backup',
    name: job.name,
    devices: job.devices,
    concurrency: job.concurrency,
    outDir,
    credentials: job.credentials,
    acceptNewHostKeys: job.acceptNewHostKeys,
    enablePassword: job.enablePassword || undefined,
    prompt: job.prompt || undefined,
    timeoutMs: job.timeoutSec * 1000,
  }, deps, onProgress);
  return { runner, done: runner.run((conn, r) => backupDevice(conn, r, baseDir, job.command, job.timeoutSec * 1000)) };
}
