// Permisos de archivos de clave privada.
//
// OpenSSH (también el de Windows) rechaza una clave privada si otros usuarios pueden leerla:
// «WARNING: UNPROTECTED PRIVATE KEY FILE! … bad permissions». En Linux basta con chmod 600;
// en Windows hay que quitar la herencia de la ACL y dejar sólo al usuario actual (y SYSTEM),
// que es lo que hace `icacls clave /inheritance:r /grant:r "%USERNAME%:(R)"`.
//
// Nexus Neo no necesita estos permisos para sus propias conexiones (ssh2 lee el archivo
// directamente), pero los corrige al generar o importar claves para que el mismo archivo
// funcione también con `ssh -i`, scp, git, VS Code, etc.
import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { utils } from 'ssh2';

export interface AclRule {
  sid: string;
  name: string;
  allow: boolean;
  rights: number;
}

export interface AclDump {
  userSid: string;
  ownerSid?: string;
  rules: AclRule[];
}

export interface PermCheck {
  ok: boolean;
  /** Quién tiene acceso indebido, legible para mostrarlo al usuario. */
  offenders: string[];
  /** El propietario no es el usuario actual, SYSTEM ni Administradores. */
  badOwner?: string;
}

/** Ejecuta un script de PowerShell con variables de entorno extra y devuelve su salida. */
export type PsRunner = (script: string, env: Record<string, string>) => Promise<string>;

export interface PermOptions {
  platform?: NodeJS.Platform;
  runPowerShell?: PsRunner;
}

// Identidades que OpenSSH para Windows acepta además del propio usuario.
const SYSTEM_SID = 'S-1-5-18';
const ADMINS_SID = 'S-1-5-32-544';
const TRUSTED_SIDS = new Set([SYSTEM_SID, ADMINS_SID]);

const PS_PREFIX = "$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n";

// Vuelca, una por línea, el SID del usuario, el propietario y las ACE de cada archivo.
// Las rutas llegan por variable de entorno (nunca dentro del script) para no tener que escaparlas.
const PS_DUMP = PS_PREFIX + `
$sidT=[System.Security.Principal.SecurityIdentifier]
"USER|"+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach($p in ($env:NN_KEY_PATHS -split "\`n")){
  if(-not $p){continue}
  "FILE|$p"
  try{
    $acl=Get-Acl -LiteralPath $p
    try{"OWNER|"+$acl.GetOwner($sidT).Value}catch{}
    foreach($r in $acl.GetAccessRules($true,$true,$sidT)){
      $n=''
      try{$n=$r.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value}catch{}
      "ACE|"+$r.IdentityReference.Value+"|"+$r.AccessControlType+"|"+[int64]$r.FileSystemRights+"|"+$n
    }
  }catch{"ERROR|"+$_.Exception.Message}
}
`;

// Sustituye la ACL por una protegida (sin herencia) con control total para el usuario y SYSTEM.
const PS_FIX = PS_PREFIX + `
$p=$env:NN_KEY_PATH
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sys=New-Object System.Security.Principal.SecurityIdentifier('${SYSTEM_SID}')
$acl=New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sys,'FullControl','Allow')))
Set-Acl -LiteralPath $p -AclObject $acl
try{
  $o=Get-Acl -LiteralPath $p
  $owner=$o.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($owner -ne $me.Value -and $owner -ne '${SYSTEM_SID}' -and $owner -ne '${ADMINS_SID}'){
    $o.SetOwner($me)
    Set-Acl -LiteralPath $p -AclObject $o
  }
}catch{}
"OK"
`;

/** Ejecuta PowerShell de Windows sin perfil y con el script codificado (sin problemas de comillas). */
export const defaultPowerShell: PsRunner = (script, env) =>
  new Promise((resolvePs, reject) => {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      existsSync(exe) ? exe : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).toString().trim()));
        else resolvePs(stdout.toString());
      },
    );
  });

/** Interpreta la salida de PS_DUMP: un AclDump por archivo. */
export function parseAclDump(text: string): Map<string, AclDump | Error> {
  const out = new Map<string, AclDump | Error>();
  let userSid = '';
  let current: AclDump | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [tag, ...rest] = line.split('|');
    if (tag === 'USER') userSid = rest[0];
    else if (tag === 'FILE') {
      current = { userSid, rules: [] };
      out.set(rest.join('|'), current);
    } else if (!current) continue;
    else if (tag === 'OWNER') current.ownerSid = rest[0];
    else if (tag === 'ACE') {
      const [sid, type, rights, ...name] = rest;
      current.rules.push({ sid, allow: /^allow$/i.test(type), rights: Number(rights) || 0, name: name.join('|') });
    } else if (tag === 'ERROR') {
      const path = [...out.keys()].pop()!;
      out.set(path, new Error(rest.join('|')));
      current = undefined;
    }
  }
  return out;
}

const label = (sid: string, name: string) => (name ? `${name} (${sid})` : sid);

/** Aplica las mismas reglas que OpenSSH para Windows a una ACL ya volcada. */
export function evaluateAcl(dump: AclDump): PermCheck {
  const offenders: string[] = [];
  for (const r of dump.rules) {
    if (!r.allow || r.rights === 0) continue;
    if (r.sid === dump.userSid || TRUSTED_SIDS.has(r.sid)) continue;
    const l = label(r.sid, r.name);
    if (!offenders.includes(l)) offenders.push(l);
  }
  const owner = dump.ownerSid;
  const badOwner = owner && owner !== dump.userSid && !TRUSTED_SIDS.has(owner) ? owner : undefined;
  return { ok: offenders.length === 0 && !badOwner, offenders, ...(badOwner ? { badOwner } : {}) };
}

function evaluateMode(mode: number): PermCheck {
  const extra = mode & 0o077;
  if (!extra) return { ok: true, offenders: [] };
  const offenders: string[] = [];
  if (extra & 0o070) offenders.push('grupo');
  if (extra & 0o007) offenders.push('otros usuarios');
  return { ok: false, offenders: offenders.map((o) => `${o} (modo ${(mode & 0o777).toString(8).padStart(4, '0')})`) };
}

/** Comprueba si OpenSSH aceptaría los permisos de varias claves (una sola llamada a PowerShell). */
export async function checkKeyPermissionsMany(paths: string[], opts: PermOptions = {}): Promise<Map<string, PermCheck | Error>> {
  const platform = opts.platform ?? process.platform;
  const out = new Map<string, PermCheck | Error>();
  if (!paths.length) return out;
  if (platform !== 'win32') {
    for (const p of paths) {
      try {
        out.set(p, evaluateMode((await fs.stat(p)).mode));
      } catch (e) {
        out.set(p, e as Error);
      }
    }
    return out;
  }
  const run = opts.runPowerShell ?? defaultPowerShell;
  const dumps = parseAclDump(await run(PS_DUMP, { NN_KEY_PATHS: paths.join('\n') }));
  for (const p of paths) {
    const d = dumps.get(p);
    out.set(p, !d ? new Error('No se pudieron leer los permisos.') : d instanceof Error ? d : evaluateAcl(d));
  }
  return out;
}

export async function checkKeyPermissions(path: string, opts: PermOptions = {}): Promise<PermCheck> {
  const r = (await checkKeyPermissionsMany([path], opts)).get(path)!;
  if (r instanceof Error) throw r;
  return r;
}

/** Instrucciones manuales por si la corrección automática falla. */
export function manualFixHint(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `Ejecuta en PowerShell:\n  icacls "${path}" /inheritance:r\n  icacls "${path}" /grant:r "$($env:USERNAME):(R)"`;
  }
  return `Ejecuta: chmod 600 '${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Deja la clave accesible sólo para el usuario actual (como exige OpenSSH) y lo verifica.
 * Lanza un error con instrucciones manuales si no lo consigue.
 */
export async function protectKeyFile(path: string, opts: PermOptions = {}): Promise<PermCheck> {
  const platform = opts.platform ?? process.platform;
  const fail = (why: string) =>
    new Error(`No se pudieron corregir los permisos de ${(platform === 'win32' ? win32.basename : basename)(path)}: ${why}\n${manualFixHint(path, platform)}`);
  try {
    if (platform === 'win32') {
      const run = opts.runPowerShell ?? defaultPowerShell;
      const r = await run(PS_FIX, { NN_KEY_PATH: path });
      if (!/\bOK\b/.test(r)) throw new Error(r.trim() || 'PowerShell no confirmó el cambio.');
    } else {
      await fs.chmod(path, 0o600);
    }
  } catch (e) {
    throw fail((e as Error).message);
  }
  const after = await checkKeyPermissions(path, opts).catch((e: Error) => {
    throw fail(e.message);
  });
  if (!after.ok) throw fail(`siguen teniendo acceso ${[...after.offenders, ...(after.badOwner ? [`propietario ${after.badOwner}`] : [])].join(', ')}.`);
  return after;
}

/** Normaliza para comparar rutas (Windows no distingue mayúsculas). */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const n = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
}

export interface ImportResult {
  privatePath: string;
  publicPath?: string;
  copied: boolean;
}

/**
 * Importa una clave privada a la carpeta .ssh (con su .pub si existe al lado) y la protege.
 * Si ya está dentro de .ssh, sólo corrige los permisos.
 */
export async function importKeyFile(src: string, destDir: string, opts: PermOptions & { name?: string; overwrite?: boolean } = {}): Promise<ImportResult> {
  const platform = opts.platform ?? process.platform;
  const data = await fs.readFile(src);
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PuTTY-User-Key-File/.test(data.toString('latin1'))) {
    throw new Error(`${basename(src)} no parece una clave privada (OpenSSH, PEM o PuTTY).`);
  }
  if (samePath(dirname(src), destDir, platform)) {
    await protectKeyFile(src, opts);
    return { privatePath: src, publicPath: existsSync(`${src}.pub`) ? `${src}.pub` : undefined, copied: false };
  }
  const name = opts.name || basename(src);
  if (!/^[\w.@-]+$/.test(name)) throw new Error('Nombre de archivo no válido.');
  const dest = join(destDir, name);
  if (existsSync(dest) && !opts.overwrite) {
    const same = (await fs.readFile(dest)).equals(data);
    if (!same) throw new Error(`Ya existe otra clave llamada ${name} en ${destDir}.`);
  }
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, data, { mode: 0o600 });
  let publicPath: string | undefined;
  if (existsSync(`${src}.pub`)) {
    publicPath = `${dest}.pub`;
    await fs.copyFile(`${src}.pub`, publicPath);
  } else {
    // Sin .pub al lado: se deriva de la privada si no está cifrada (así aparece en el gestor).
    const parsed = utils.parseKey(data);
    const k = parsed instanceof Error ? undefined : Array.isArray(parsed) ? parsed[0] : parsed;
    if (k) {
      publicPath = `${dest}.pub`;
      const comment = k.comment || name;
      await fs.writeFile(publicPath, `${k.type} ${k.getPublicSSH().toString('base64')} ${comment}\n`, { mode: 0o644 });
    }
  }
  await protectKeyFile(dest, opts);
  return { privatePath: dest, publicPath, copied: true };
}
