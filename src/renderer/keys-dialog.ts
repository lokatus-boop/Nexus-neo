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
          el('code', {}, `${k.type} · ${k.fingerprint}${k.comment ? ' · ' + k.comment : ''}`)),
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
      return k;
    } },
  ], { dismiss: null });
}
