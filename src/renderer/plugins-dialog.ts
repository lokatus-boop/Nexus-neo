// Gestión de plugins: instalar desde una carpeta, activar (aceptando sus permisos), desactivar,
// quitar y ver errores.
import { api } from './api';
import { el, modal, toast, errMsg, confirmDialog, icon } from './ui';
import type { PluginHost } from './plugin-host';
import type { PluginInfo, PluginPermission } from '../shared/types';

const PERM_TEXT: Record<PluginPermission, string> = {
  'terminal:read': 'Leer lo que aparece en los terminales',
  'terminal:write': 'Escribir en el terminal activo (como si tecleases)',
  'sessions:read': 'Ver la lista de sesiones guardadas (nombre, tipo y host; nunca contraseñas)',
};

/** Arranca los plugins activados (al iniciar la app o tras cambiar algo). */
export async function startPlugins(host: PluginHost): Promise<void> {
  const list = (await api.plugins.list()) as PluginInfo[];
  const settings = await api.settings.get();
  for (const p of list) {
    if (!p.enabled || p.needsApproval || !p.manifest) {
      host.stop(p.id);
      continue;
    }
    if (host.isRunning(p.id)) continue;
    try {
      const { manifest, code } = (await api.plugins.code(p.id)) as { manifest: PluginInfo['manifest']; code: string };
      host.start(manifest!, code, settings.plugins[p.id]?.permissions || []);
    } catch (e) {
      host.errors.set(p.id, errMsg(e));
    }
  }
}

async function approve(p: PluginInfo): Promise<boolean> {
  const perms = p.manifest!.permissions || [];
  const body = el('div', {},
    el('p', {}, `«${p.manifest!.name}» ${p.manifest!.version}${p.manifest!.author ? ` de ${p.manifest!.author}` : ''} es código de terceros. Se ejecuta aislado (sin acceso a tus archivos, a la red ni a la bóveda), pero actívalo sólo si confías en su origen.`),
    perms.length
      ? el('div', {}, el('p', {}, 'Pide estos permisos:'), el('ul', {}, ...perms.map((x) => el('li', {}, PERM_TEXT[x]))))
      : el('p', {}, 'No pide permisos especiales: sólo puede añadir comandos a la paleta, mostrar avisos, añadir temas y guardar sus propios datos.'),
  );
  return modal<boolean>(`Activar ${p.manifest!.name}`, body, [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: 'Activar', value: true, kind: 'primary' },
  ], { dismiss: false });
}

export async function pluginsDialog(host: PluginHost): Promise<void> {
  const listEl = el('div', { class: 'pl-list' });
  const render = async () => {
    const list = (await api.plugins.list()) as PluginInfo[];
    listEl.replaceChildren(...(list.length ? list.map((p) => {
      const m = p.manifest;
      const running = host.isRunning(p.id);
      const err = p.error || host.errors.get(p.id);
      const state = p.error ? 'Manifiesto no válido' : p.needsApproval ? 'Pide permisos nuevos' : running ? 'Activo' : p.enabled ? 'Activado (con errores)' : 'Desactivado';
      const toggle = el('button', { class: `btn ${p.enabled && !p.needsApproval ? 'ghost' : 'primary'} small`, type: 'button', disabled: !!p.error, onclick: async () => {
        try {
          if (p.enabled && !p.needsApproval) {
            await api.plugins.disable(p.id);
            host.stop(p.id);
          } else {
            if (!(await approve(p))) return;
            await api.plugins.enable(p.id, m!.permissions || []);
            await startPlugins(host);
            toast(`Plugin «${m!.name}» activado`, 'ok');
          }
          await render();
        } catch (e) {
          toast(errMsg(e), 'error');
        }
      } }, p.enabled && !p.needsApproval ? 'Desactivar' : p.needsApproval ? 'Revisar permisos' : 'Activar');
      const remove = el('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        if (!(await confirmDialog('Quitar plugin', `¿Quitar «${m?.name || p.id}» y sus datos?`, 'Quitar', true))) return;
        host.stop(p.id);
        await api.plugins.remove(p.id);
        await render();
      } }, 'Quitar');
      return el('div', { class: `pl-row${running ? ' on' : ''}`, 'data-plugin': p.id },
        el('div', { class: 'pl-head' }, el('b', {}, m?.name || p.id), m ? el('small', {}, ` ${m.version}${m.author ? ` · ${m.author}` : ''}`) : null, el('span', { class: `pl-state${running ? ' on' : ''}` }, state)),
        m?.description ? el('p', { class: 'hint' }, m.description) : null,
        m?.permissions?.length ? el('p', { class: 'hint' }, `Permisos: ${m.permissions.map((x) => PERM_TEXT[x]).join(' · ')}`) : null,
        err ? el('p', { class: 'danger-text' }, err) : null,
        el('div', { class: 'row end' }, remove, toggle),
      );
    }) : [el('p', { class: 'hint' }, 'No hay plugins instalados. Un plugin es una carpeta con manifest.json y main.js: instálalo desde su carpeta o cópialo en la carpeta de plugins.')]));
  };
  await render();
  const install = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    try {
      const m = await api.plugins.install();
      if (m) {
        toast(`Plugin «${m.name}» instalado. Actívalo para usarlo.`, 'ok');
        await render();
      }
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, icon('import'), ' Instalar desde carpeta…');
  const open = el('button', { class: 'btn ghost', type: 'button', onclick: () => void api.plugins.openDir() }, icon('folder'), ' Abrir carpeta de plugins');
  const reload = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    host.stopAll();
    await startPlugins(host);
    await render();
    toast('Plugins recargados', 'ok');
  } }, icon('refresh'), ' Recargar');
  await modal<boolean>('Plugins', el('div', { class: 'session-form' },
    el('p', {}, 'Los plugins añaden comandos a la paleta (Ctrl+Mayús+K), reaccionan a lo que sale en los terminales, muestran información en la barra de estado y aportan temas. Se ejecutan aislados y sólo con los permisos que aceptes. Cómo escribir uno: docs/plugins.md.'),
    el('div', { class: 'row' }, install, open, reload),
    listEl,
  ), [{ label: 'Cerrar', value: true, kind: 'primary' }], { wide: true, dismiss: true });
}
