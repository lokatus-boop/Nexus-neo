// Gestor de claves SSH: listar, generar e instalar en el servidor de la pestaña activa.
import { api } from './api';
import { el, icon, modal, field, input, select, toast, errMsg } from './ui';

interface KeyInfo {
  name: string;
  privatePath: string;
  publicKey: string;
  type: string;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  permsOk?: boolean;
  permsIssue?: string;
}

interface PermCheck {
  ok: boolean;
  offenders: string[];
  badOwner?: string;
}

/** Muestra un error de permisos con sus instrucciones manuales (respeta los saltos de línea). */
export async function permErrorDialog(e: unknown): Promise<void> {
  await modal('No se pudieron corregir los permisos', el('pre', { class: 'perm-error' }, errMsg(e)), [
    { label: 'Cerrar', value: true, kind: 'primary' },
  ], { dismiss: true });
}

/**
 * Comprueba si `ssh` (OpenSSH) aceptaría los permisos de la clave elegida y, si no, ofrece
 * corregirlos o copiarla protegida a la carpeta .ssh. Devuelve la ruta que debe usarse.
 */
export async function ensureKeyPermissions(path: string): Promise<string> {
  let check: PermCheck;
  try {
    check = (await api.keys.checkPerms(path)) as PermCheck;
  } catch {
    return path; // sin información: Nexus Neo puede usarla igualmente
  }
  if (check.ok) return path;
  const who = [...check.offenders, ...(check.badOwner ? [`propietario ${check.badOwner}`] : [])].join(', ');
  const choice = await modal<'fix' | 'import' | 'keep'>('Permisos de la clave demasiado abiertos', el('div', {},
    el('p', {}, 'Otros usuarios del equipo pueden leer esta clave privada. Nexus Neo puede usarla igualmente, pero ', el('code', {}, 'ssh -i'), ', scp, git y otros programas basados en OpenSSH la rechazarán con «UNPROTECTED PRIVATE KEY FILE».'),
    el('p', {}, el('strong', {}, 'Con acceso: '), who),
    el('small', { class: 'hint' }, '«Corregir» deja la clave legible sólo por tu usuario. «Copiar a .ssh» guarda una copia protegida en tu carpeta .ssh y la usa en esta sesión.'),
  ), [
    { label: 'Dejar así', value: 'keep', kind: 'ghost' },
    { label: 'Copiar a .ssh', value: 'import', kind: 'ghost' },
    { label: 'Corregir permisos', value: 'fix', kind: 'primary' },
  ], { dismiss: 'keep' });
  try {
    if (choice === 'fix') {
      await api.keys.fixPerms(path);
      toast('Permisos corregidos: sólo tu usuario puede leer la clave', 'ok');
    } else if (choice === 'import') {
      const r = (await api.keys.import(path)) as { privatePath: string };
      toast(`Clave copiada y protegida en ${r.privatePath}`, 'ok');
      return r.privatePath;
    }
  } catch (e) {
    await permErrorDialog(e);
  }
  return path;
}

export async function keysDialog(active: { connId: string; title: string; isSsh: boolean } | null): Promise<void> {
  const list = el('div', { class: 'macro-list' });
  const dirLabel = el('small', { class: 'hint' });
  const install = async (k: KeyInfo) => {
    if (!active?.isSsh) return toast('Abre y selecciona una pestaña SSH conectada para instalar la clave.', 'error');
    try {
      const r = await api.keys.install(active.connId, k.publicKey);
      toast(r === 'added' ? `Clave ${k.name} añadida a authorized_keys en ${active.title}` : `La clave ya estaba instalada en ${active.title}`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const render = async () => {
    const { dir, keys } = (await api.keys.list()) as { dir: string; keys: KeyInfo[] };
    dirLabel.textContent = `Carpeta: ${dir}`;
    list.replaceChildren(
      ...keys.map((k) => el('div', { class: 'macro-row' },
        el('div', { class: 'macro-info' },
          el('strong', {}, `${k.name}${k.encrypted ? ' 🔒' : ''}`),
          el('code', {}, `${k.type} · ${k.fingerprint}${k.comment ? ' · ' + k.comment : ''}`),
          k.permsOk === false ? el('small', { class: 'perm-warn' }, `⚠ Permisos demasiado abiertos (${k.permsIssue}). «ssh -i» la rechazará.`) : null),
        k.permsOk === false ? el('button', { class: 'btn ghost', title: 'Dejar la clave legible sólo por tu usuario', onclick: async () => {
          try {
            await api.keys.fixPerms(k.privatePath);
            toast(`Permisos de ${k.name} corregidos`, 'ok');
            await render();
          } catch (e) {
            await permErrorDialog(e);
          }
        } }, icon('lock', 14), ' Corregir') : null,
        el('button', { class: 'btn ghost', title: 'Copiar la clave pública', onclick: () => {
          void navigator.clipboard.writeText(k.publicKey);
          toast('Clave pública copiada');
        } }, icon('copy', 14), ' Copiar'),
        el('button', { class: 'btn ghost', title: active?.isSsh ? `Instalar en ${active.title}` : 'Necesitas una pestaña SSH activa', disabled: !active?.isSsh, onclick: () => void install(k) }, icon('upload', 14), ' Instalar'),
      )),
      ...(keys.length ? [] : [el('div', { class: 'empty' }, 'No hay claves en la carpeta .ssh. Genera una nueva.')]),
    );
  };
  await render();
  await modal('Claves SSH', el('div', {}, list, dirLabel,
    el('small', { class: 'hint' }, active?.isSsh ? `«Instalar» añade la clave pública al authorized_keys de ${active.title}.` : 'Para instalar una clave en un servidor, selecciona antes una pestaña SSH conectada.')), [
    { label: 'Importar…', kind: 'ghost', value: async () => {
      try {
        const r = (await api.keys.import()) as { privatePath: string; copied: boolean } | null;
        if (r) {
          toast(r.copied ? `Clave importada y protegida en ${r.privatePath}` : `Permisos de ${r.privatePath} corregidos`, 'ok');
          await render();
        }
      } catch (e) {
        await permErrorDialog(e);
      }
      return undefined;
    } },
    { label: 'Abrir carpeta', kind: 'ghost', value: async () => {
      await api.keys.openDir();
      return undefined;
    } },
    { label: 'Generar nueva…', kind: 'ghost', value: async () => {
      const k = await generateDialog();
      if (k) {
        await render();
        if (active?.isSsh && (await modal('Instalar clave', el('p', {}, `¿Instalar ${k.name} en ${active.title} para entrar sin contraseña?`), [
          { label: 'Ahora no', value: false, kind: 'ghost' },
          { label: 'Instalar', value: true, kind: 'primary' },
        ], { dismiss: false }))) await install(k);
      }
      return undefined;
    } },
    { label: 'Cerrar', value: true, kind: 'primary' },
  ], { wide: true, dismiss: true });
}

async function generateDialog(): Promise<KeyInfo | null> {
  const type = select([['ed25519', 'Ed25519 (recomendada)'], ['ecdsa', 'ECDSA'], ['rsa', 'RSA']], 'ed25519');
  const bits = select([['4096', '4096'], ['3072', '3072'], ['2048', '2048']], '4096');
  const ecBits = select([['256', '256'], ['384', '384'], ['521', '521']], '256');
  const name = input({ value: 'id_ed25519' });
  const comment = input({ value: 'nexus-neo', placeholder: 'usuario@equipo' });
  const p1 = input({ type: 'password', placeholder: 'Opcional, pero recomendada' });
  const p2 = input({ type: 'password' });
  const bitsField = field('Bits', bits);
  const ecField = field('Curva (bits)', ecBits);
  const sync = () => {
    bitsField.style.display = type.value === 'rsa' ? '' : 'none';
    ecField.style.display = type.value === 'ecdsa' ? '' : 'none';
    if (/^id_(ed25519|rsa|ecdsa)$/.test(name.value)) name.value = `id_${type.value}`;
  };
  type.addEventListener('change', sync);
  sync();
  return modal<KeyInfo | null>('Generar clave SSH', el('div', {},
    el('div', { class: 'grid3' }, field('Tipo', type), bitsField, ecField),
    el('div', { class: 'grid2' }, field('Nombre del archivo (en .ssh)', name), field('Comentario', comment)),
    el('div', { class: 'grid2' }, field('Frase de paso', p1), field('Repítela', p2)),
  ), [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    { label: 'Generar', kind: 'primary', value: async () => {
      if (p1.value !== p2.value) throw new Error('Las frases de paso no coinciden.');
      const k = (await api.keys.generate({
        type: type.value,
        bits: Number(type.value === 'rsa' ? bits.value : ecBits.value),
        comment: comment.value.trim(),
        passphrase: p1.value || undefined,
        name: name.value.trim(),
      })) as KeyInfo;
      toast(`Clave generada: ${k.privatePath}`, 'ok');
      if (k.permsOk === false) await permErrorDialog(k.permsIssue);
      return k;
    } },
  ], { dismiss: null });
}
