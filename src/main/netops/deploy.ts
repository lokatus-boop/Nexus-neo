// Despliegue masivo: ejecuta órdenes (y opcionalmente sube un archivo antes) en una lista de
// equipos, en paralelo, guardando la salida y el resultado de cada uno.
import { basename, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { SFTPWrapper } from 'ssh2';
import { JobRunner, RunnerDeps, stamp, DeviceConnection } from './runner';
import { scpUpload } from './scp';
import { QUESTION } from './cli';
import { renderTemplate, Vars } from '../../shared/template';
import * as sftpOps from '../sftp-ops';
import type { DeployJob, DeviceRunResult, JobProgress, NetDevice } from '../../shared/types';

export const DEFAULT_ERROR_PATTERN = String.raw`^\s*% ?(Invalid|Incomplete|Ambiguous|Unknown|Error|Bad)|^\s*(Error|ERROR|error):|Invalid input|command not found|Unrecognized command|syntax error`;

/** Primera IPv4 no interna del equipo (para {{tftp}}). */
export function localIPv4(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

export function deviceVars(dev: NetDevice, job: Pick<DeployJob, 'vars' | 'upload'>, now = new Date()): Vars {
  const iso = now.toISOString();
  return {
    tftp: localIPv4(),
    date: iso.slice(0, 10),
    time: now.toTimeString().slice(0, 8),
    datetime: stamp(now),
    file: job.upload ? basename(job.upload.localPath) : '',
    ...job.vars,
    host: dev.host,
    name: dev.name,
    user: dev.username || '',
    ...dev.vars,
  };
}

export type Step =
  | { type: 'cmd'; text: string }
  | { type: 'sleep'; ms: number }
  | { type: 'enter' }
  | { type: 'send'; text: string }
  | { type: 'timeout'; ms: number };

/**
 * Convierte el texto de órdenes en pasos. Líneas vacías y las que empiezan por «#» se ignoran.
 * Directivas: «!espera 5» (segundos), «!intro» (Intro sin orden, p. ej. para aceptar un valor
 * por defecto), «!enviar texto» (sin esperar al prompt) y «!timeout 600» (para las siguientes).
 */
export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^\s*!(\w+)\s*(.*)$/.exec(line);
    if (m) {
      const [, d, arg] = m;
      const n = Number(arg);
      if (/^(espera|sleep|wait)$/i.test(d)) steps.push({ type: 'sleep', ms: (Number.isFinite(n) ? n : 1) * 1000 });
      else if (/^(intro|enter)$/i.test(d)) steps.push({ type: 'enter' });
      else if (/^(enviar|send)$/i.test(d)) steps.push({ type: 'send', text: arg });
      else if (/^timeout$/i.test(d)) steps.push({ type: 'timeout', ms: Math.max(1, n || 30) * 1000 });
      else steps.push({ type: 'cmd', text: line.trim() });
      continue;
    }
    steps.push({ type: 'cmd', text: line.trim() });
  }
  return steps;
}

async function upload(conn: DeviceConnection, job: DeployJob, vars: Vars): Promise<void> {
  const up = job.upload!;
  if (!conn.ssh) throw new Error('La subida de archivos necesita SSH (el equipo usa Telnet: usa TFTP con {{tftp}}).');
  const remote = renderTemplate(up.remotePath, vars).text;
  const file = basename(up.localPath);
  conn.log(`Subiendo ${file} a ${remote} por ${up.method.toUpperCase()}…`);
  let lastPct = -1;
  const progress = (sent: number, total: number) => {
    const pct = total ? Math.floor((sent / total) * 10) * 10 : 100;
    if (pct !== lastPct) {
      lastPct = pct;
      conn.log(`  ${pct}%`);
    }
  };
  if (up.method === 'scp') await scpUpload(conn.ssh, up.localPath, remote, progress);
  else {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => conn.ssh!.sftp((e, s) => (e ? reject(e) : resolve(s))));
    try {
      const isDir = remote.endsWith('/') || (await new Promise<boolean>((r) => sftp.stat(remote, (e, st) => r(!e && st.isDirectory()))));
      if (isDir) await sftpOps.upload(sftp, up.localPath, remote, (_f, s, t) => progress(s, t));
      else {
        const dir = remote.includes('/') ? remote.slice(0, remote.lastIndexOf('/')) || '/' : '.';
        const tmpName = join(dir, file).replace(/\\/g, '/');
        await sftpOps.upload(sftp, up.localPath, dir, (_f, s, t) => progress(s, t));
        if (tmpName !== remote) await sftpOps.rename(sftp, tmpName, remote);
      }
    } finally {
      sftp.end();
    }
  }
  conn.log('Subida completada.');
}

export function runDeploy(job: DeployJob, deps: RunnerDeps, baseDir: string, onProgress: (p: JobProgress) => void): { runner: JobRunner; done: Promise<JobProgress> } {
  const steps = parseSteps(job.commands);
  if (!steps.length && !job.upload) throw new Error('No hay órdenes que ejecutar.');
  if (!job.devices.length) throw new Error('Elige al menos un equipo.');
  const errorRe = new RegExp(job.errorPattern || DEFAULT_ERROR_PATTERN, 'im');
  const outDir = join(baseDir, `${stamp()}_${job.name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'despliegue'}`);
  const runner = new JobRunner({
    kind: 'deploy',
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
  const task = async (conn: DeviceConnection, r: DeviceRunResult) => {
    const vars = deviceVars(conn.device, job);
    if (job.upload) await upload(conn, job, vars);
    let timeout = job.timeoutSec * 1000;
    let failures = 0;
    for (const step of steps) {
      if (step.type === 'sleep') {
        conn.log(`(espera ${step.ms / 1000} s)`);
        await new Promise((res) => setTimeout(res, step.ms));
        continue;
      }
      if (step.type === 'timeout') {
        timeout = step.ms;
        continue;
      }
      if (step.type === 'send') {
        conn.cli.send(renderTemplate(step.text, vars).text);
        continue;
      }
      const { text, missing } = step.type === 'enter' ? { text: '', missing: [] } : renderTemplate(step.text, vars);
      if (missing.length) throw new Error(`Faltan variables para este equipo: ${missing.join(', ')}`);
      conn.log(step.type === 'enter' ? '> (Intro)' : `> ${text}`);
      const out = await conn.cli.run(text, timeout);
      if (out) conn.log(out);
      if (QUESTION.test(out)) continue; // la siguiente línea responde a la pregunta
      if (errorRe.test(out)) {
        failures++;
        r.message = `Error en «${text}»`;
        if (job.stopOnError) throw new Error(`${r.message}: ${out.split('\n').find((l) => errorRe.test(l))?.trim() || ''}`);
      }
      if (conn.cli.isClosed) break;
    }
    if (failures) {
      r.status = 'error';
      r.message = `${failures} orden(es) con error`;
    }
  };
  return { runner, done: runner.run(task) };
}
