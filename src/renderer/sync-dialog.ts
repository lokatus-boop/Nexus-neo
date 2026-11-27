// Diálogo de sincronización cifrada entre equipos.
import { api } from './api';
import { el, field, input, select, checkbox, modal, toast, errMsg } from './ui';
import type { SessionConfig, Settings, SyncStatus } from '../shared/types';

function describeStatus(st: SyncStatus): string {
  if (st.running) return 'Sincronizando…';
  if (st.lastError) return `Último intento con error: ${st.lastError}`;
  if (!st.lastSync) return st.configured ? (st.hasPassphrase ? 'Aún no se ha sincronizado en esta sesión.' : 'Falta la frase de sincronización.') : 'Sin configurar.';
  const r = st.lastResult;
  const when = new Date(st.lastSync).toLocaleTimeString();
  const changes = r ? `${r.added} nuevas, ${r.updated} actualizadas, ${r.removed} eliminadas` : '';
  return `Sincronizado a las ${when}${changes ? ` · ${changes}` : ''}${r?.devices.length ? ` · equipos: ${r.devices.join(', ')}` : ''}`;
}

export async function syncDialog(settings: Settings, sessions: SessionConfig[], vaultUnlocked: boolean): Promise<Settings['sync'] | null> {
  const c = settings.sync;
  let status = (await api.sync.status()) as SyncStatus;
  const enabled = checkbox('Activar la sincronización en este equipo', c.enabled);
  const mode = select([['folder', 'Carpeta compartida (Dropbox, OneDrive, Google Drive, Syncthing, NAS…)'], ['sftp', 'Servidor SFTP (a través de una sesión SSH guardada)']], c.mode);
  const path = input({ value: c.path, placeholder: c.mode === 'folder' ? 'C:\\Users\\yo\\Dropbox\\NexusNeo' : '/home/yo/.nexus-neo' });
  const pick = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    const d = await api.pickDir('Carpeta de sincronización', path.value || undefined);
    if (d) path.value = d;
  } }, 'Elegir…');
  const session = select([['', '— Elige una sesión SSH —'], ...sessions.filter((s) => s.kind === 'ssh').map((s) => [s.id, `${s.name} (${s.host})`] as [string, string])], c.sessionId || '');
  const p1 = input({ type: 'password', placeholder: status.hasPassphrase ? 'Guardada. Déjalo vacío para mantenerla.' : 'Mínimo 8 caracteres' });
  const p2 = input({ type: 'password', placeholder: 'Repite la frase' });
  const secrets = checkbox('Sincronizar también las contraseñas de la bóveda (viajan cifradas con la frase)', c.includeSecrets);
  const interval = input({ type: 'number', min: '0', value: String(c.intervalMin) });
  const device = input({ value: c.deviceName, placeholder: 'Nombre de este equipo (por defecto, el del sistema)' });
  const statusEl = el('p', { class: 'hint', id: 'sync-status' }, describeStatus(status));
  const pathField = field('Carpeta', path);
  const sessionField = field('Servidor', session);
  const pathHolder = el('div', {}, sessionField, el('div', { class: 'row' }, pathField, pick));
  const update = () => {
    const folder = mode.value === 'folder';
    pathField.querySelector('.field-label')!.textContent = folder ? 'Carpeta' : 'Ruta remota (carpeta o archivo .json)';
    sessionField.style.display = folder ? 'none' : '';
    pick.style.display = folder ? '' : 'none';
    path.placeholder = folder ? 'p. ej. C:\\Users\\yo\\Dropbox\\NexusNeo' : '/home/yo/.nexus-neo';
  };
  mode.addEventListener('change', update);
  update();
  if (!vaultUnlocked) secrets.box.disabled = true;

  const read = (): { cfg: Settings['sync']; pass: string | null | undefined } => {
    if (p1.value !== p2.value) throw new Error('Las frases no coinciden.');
    if (enabled.box.checked && !status.hasPassphrase && !p1.value) throw new Error('Elige una frase de sincronización. Usa la misma en todos tus equipos.');
    return {
      cfg: {
        enabled: enabled.box.checked,
        mode: mode.value as 'folder' | 'sftp',
        path: path.value.trim(),
        sessionId: mode.value === 'sftp' ? session.value || undefined : undefined,
        includeSecrets: secrets.box.checked,
        intervalMin: Number(interval.value) || 0,
        deviceName: device.value.trim(),
      },
      pass: p1.value ? p1.value : undefined,
    };
  };

  const body = el('div', { class: 'session-form' },
    el('p', {}, 'Comparte tus sesiones, macros y plantillas entre tus equipos. Todo viaja en un único archivo cifrado con tu frase de sincronización (scrypt + AES-256-GCM): ni el servicio de la nube ni el servidor pueden leerlo. Si cambias algo en dos equipos a la vez, gana el cambio más reciente; lo que borres se borra en todos.'),
    enabled.wrap,
    field('Dónde', mode),
    pathHolder,
    el('div', { class: 'grid2' }, field('Frase de sincronización', p1, vaultUnlocked ? 'Se guarda en la bóveda de este equipo.' : 'Bóveda bloqueada: sólo se recordará hasta cerrar la app.'), field('Repítela', p2)),
    secrets.wrap,
    el('div', { class: 'grid2' }, field('Sincronizar cada (minutos, 0 = sólo al cambiar algo)', interval), field('Nombre del equipo', device)),
    statusEl,
  );
  const off = api.sync.onStatus((st: SyncStatus) => {
    status = st;
    statusEl.textContent = describeStatus(st);
  });
  const result = await modal<Settings['sync'] | null>('Sincronización cifrada', body, [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    { label: 'Sincronizar ahora', kind: 'ghost', value: async () => {
      const { cfg, pass } = read();
      status = await api.sync.configure({ ...cfg, enabled: true }, pass);
      enabled.box.checked = true;
      p1.value = p2.value = '';
      if (status.hasPassphrase) p1.placeholder = 'Guardada. Déjalo vacío para mantenerla.';
      try {
        status = await api.sync.run();
        statusEl.textContent = describeStatus(status);
        toast('Sincronización completada', 'ok');
      } catch (e) {
        statusEl.textContent = `Error: ${errMsg(e)}`;
        toast(errMsg(e), 'error');
      }
      return undefined as unknown as null; // el diálogo sigue abierto

    } },
    { label: 'Guardar', kind: 'primary', value: async () => {
      const { cfg, pass } = read();
      await api.sync.configure(cfg, pass);
      return cfg;
    } },
  ], { wide: true, dismiss: null });
  off();
  return result;
}
