import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, uid } from './api';
import { el, icon, toast, errMsg, modal, field, input, select, checkbox, confirmDialog, promptDialog, contextMenu } from './ui';
import { Tab, TabHost, kindIcon } from './tab';
import { editSession } from './session-editor';
import { parseQuickConnect } from './quick-connect';
import { parseMacro, runMacro, encodeRecording } from './macro-engine';
import { THEMES, themeById, applyUiTheme } from './themes';
import { ServersPanel } from './servers-panel';
import { aboutDialog, ensureDisclaimerAccepted, logo } from './about';
import { AUTHOR } from '../shared/legal';
import { keysDialog } from './keys-dialog';

const serversPanel = new ServersPanel();
import type { AuthPrompt, HostKeyPrompt, Macro, SessionConfig, Settings, TunnelStatus, VaultStatus } from '../shared/types';

interface AppInfo {
  platform: string;
  version: string;
  shells: { id: string; name: string; command: string }[];
  dataDir: string;
  home: string;
  versions?: { electron: string; chrome: string; node: string };
}

const state = {
  info: null as AppInfo | null,
  sessions: [] as SessionConfig[],
  macros: [] as Macro[],
  settings: null as Settings | null,
  vault: { exists: false, unlocked: false } as VaultStatus,
  tabs: [] as Tab[],
  active: null as Tab | null,
  multiExec: false,
  filter: '',
  collapsed: new Set<string>(JSON.parse(localStorage.getItem('collapsed') || '[]') as string[]),
  recordingTab: null as Tab | null,
  tunnels: [] as (TunnelStatus & { sessionName?: string })[],
  layout: 'single' as Layout,
  cells: [null] as (Tab | null)[],
  focusedCell: 0,
};

type Layout = 'single' | 'cols2' | 'rows2' | 'grid4';
const LAYOUT_CELLS: Record<Layout, number> = { single: 1, cols2: 2, rows2: 2, grid4: 4 };
const LAYOUT_LABEL: Record<Layout, string> = { single: 'Una pestaña', cols2: 'Dos en vertical', rows2: 'Dos en horizontal', grid4: 'Cuadrícula de 4' };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---------------------------------------------------------------------------
// Pestañas

const host: TabHost = {
  settings: () => state.settings!,
  onInput(tab, data) {
    if (state.multiExec && tab.broadcast) {
      for (const t of state.tabs) if (t.broadcast && t.state === 'connected') t.write(data);
    } else tab.write(data);
  },
  onStateChange(tab) {
    if (tab === state.active) updateToolbar();
  },
};

async function openSession(session: SessionConfig): Promise<Tab | null> {
  if (session.kind === 'rdp' || session.kind === 'vnc') {
    try {
      await api.conn.open(uid(), { session, cols: 80, rows: 24 });
      const integrated = session.kind === 'vnc' ? !session.vncExternal : !session.rdpExternal && !state.settings!.rdpClient;
      toast(integrated ? `${session.kind.toUpperCase()}: abriendo ${session.name} en el visor integrado` : `${session.kind.toUpperCase()} abierto con el cliente del sistema`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
    return null;
  }
  const tab = new Tab(session, host);
  state.tabs.push(tab);
  $('#tabbar').append(tab.tabEl);
  tab.mount($('#panes'));
  tab.setBroadcastVisible(state.multiExec);
  bindTabEvents(tab);
  // En vista dividida, las pestañas nuevas ocupan primero las celdas libres.
  const empty = state.cells.indexOf(null);
  if (empty >= 0) state.focusedCell = empty;
  activate(tab);
  await tab.connect();
  if (tab.state === 'connected' && session.startupMacroId) {
    const m = state.macros.find((x) => x.id === session.startupMacroId);
    if (m) setTimeout(() => void runMacro(parseMacro(m.body), (d) => tab.write(d)), 600);
  }
  return tab;
}

function bindTabEvents(tab: Tab): void {
  tab.tabEl.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      void closeTab(tab);
    }
  });
  tab.tabEl.addEventListener('click', () => activate(tab));
  tab.pane.addEventListener('mousedown', () => {
    if (state.active !== tab) activate(tab);
  });
  tab.tabEl.addEventListener('tab-close', () => void closeTab(tab));
  tab.tabEl.addEventListener('dblclick', async () => {
    const n = await promptDialog('Renombrar pestaña', 'Título', tab.title);
    if (n) tab.rename(n);
  });
  tab.tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Duplicar', action: () => void openSession(tab.session) },
      { label: 'Reconectar', action: () => void tab.reconnect() },
      { label: 'Renombrar…', action: () => tab.tabEl.dispatchEvent(new MouseEvent('dblclick')) },
      { label: 'Mostrar/ocultar SFTP', disabled: tab.session.kind !== 'ssh', action: () => void tab.toggleSftp() },
      { label: 'Buscar…', action: () => tab.toggleSearch(true) },
      { label: 'Limpiar pantalla', action: () => tab.term.clear() },
      { label: 'Guardar salida como texto…', action: () => saveScrollback(tab) },
      { separator: true, label: '' },
      { label: 'Cerrar las demás', action: () => state.tabs.filter((t) => t !== tab).forEach((t) => void closeTab(t, true)) },
      { label: 'Cerrar', danger: true, action: () => void closeTab(tab) },
    ]);
  });
  // Reordenar arrastrando.
  tab.tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('text/nexus-tab', tab.connId);
  });
  tab.tabEl.addEventListener('dragover', (e) => e.preventDefault());
  tab.tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer!.getData('text/nexus-tab');
    const moving = state.tabs.find((t) => t.connId === id);
    if (!moving || moving === tab) return;
    state.tabs.splice(state.tabs.indexOf(moving), 1);
    state.tabs.splice(state.tabs.indexOf(tab), 0, moving);
    tab.tabEl.before(moving.tabEl);
  });
}

function saveScrollback(tab: Tab): void {
  const buf = tab.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  const blob = new Blob([lines.join('\n').replace(/\n+$/, '\n')], { type: 'text/plain' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${tab.title.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function activate(tab: Tab | null): void {
  if (tab) {
    const at = state.cells.indexOf(tab);
    if (at >= 0) state.focusedCell = at;
    else state.cells[state.focusedCell] = tab;
  }
  state.active = tab;
  renderPanes();
  updateToolbar();
}

function renderPanes(): void {
  const panes = $('#panes');
  const split = state.layout !== 'single';
  panes.className = `layout-${state.layout}`;
  panes.querySelectorAll('.cell-empty').forEach((e) => e.remove());
  for (const t of state.tabs) {
    const cell = state.cells.indexOf(t);
    t.display(cell >= 0, t === state.active, cell);
  }
  if (split) {
    state.cells.forEach((c, i) => {
      if (c) return;
      const ph = el('div', { class: `cell-empty${i === state.focusedCell ? ' focused' : ''}`, style: `order:${i}` },
        icon('split', 22), el('span', {}, 'Celda libre: elige una pestaña o abre una sesión'));
      ph.addEventListener('mousedown', () => {
        state.focusedCell = i;
        state.active = null;
        renderPanes();
      });
      panes.append(ph);
    });
  }
  $('#welcome').classList.toggle('hidden', state.tabs.length > 0 || (split && state.cells.some(Boolean)));
}

function setLayout(layout: Layout): void {
  const n = LAYOUT_CELLS[layout];
  // Conserva las pestañas visibles y rellena con las siguientes abiertas.
  const keep = state.cells.filter((c): c is Tab => !!c && state.tabs.includes(c));
  if (state.active && !keep.includes(state.active)) keep.unshift(state.active);
  for (const t of state.tabs) if (keep.length < n && !keep.includes(t)) keep.push(t);
  state.layout = layout;
  state.cells = Array.from({ length: n }, (_, i) => keep[i] || null);
  const ai = state.active ? state.cells.indexOf(state.active) : -1;
  state.focusedCell = ai >= 0 ? ai : 0;
  if (ai < 0) state.active = state.cells[0];
  renderPanes();
  updateToolbar();
}

function layoutMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 4, (Object.keys(LAYOUT_CELLS) as Layout[]).map((l) => ({
    label: `${state.layout === l ? '● ' : ''}${LAYOUT_LABEL[l]}`,
    action: () => setLayout(l),
  })));
}

async function closeTab(tab: Tab, force = false): Promise<void> {
  if (!force && state.settings!.confirmOnClose && tab.state === 'connected' && tab.session.kind !== 'local') {
    if (!(await confirmDialog('Cerrar pestaña', `¿Cerrar la sesión "${tab.title}"?`, 'Cerrar', true))) return;
  }
  if (state.recordingTab === tab) state.recordingTab = null;
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  const cell = state.cells.indexOf(tab);
  tab.dispose();
  if (cell >= 0) {
    // Rellena la celda con una pestaña abierta que no esté a la vista.
    state.cells[cell] = state.layout === 'single' ? state.tabs[Math.min(i, state.tabs.length - 1)] || null : state.tabs.find((t) => !state.cells.includes(t)) || null;
  }
  if (state.active === tab) {
    state.active = state.cells[cell] || state.cells.find(Boolean) || null;
    if (state.active) state.focusedCell = state.cells.indexOf(state.active);
  }
  renderPanes();
  updateToolbar();
}

function cycleTab(dir: number): void {
  if (!state.tabs.length) return;
  const i = state.active ? state.tabs.indexOf(state.active) : -1;
  activate(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]);
}

// ---------------------------------------------------------------------------
// Barra lateral: árbol de sesiones

function renderSidebar(): void {
  const tree = $('#session-tree');
  const q = state.filter.toLowerCase();
  const visible = state.sessions.filter((s) =>
    !q || [s.name, s.host, s.username, s.folder, s.kind].some((v) => v?.toLowerCase().includes(q)));
  const groups = new Map<string, SessionConfig[]>();
  for (const s of visible) {
    const f = s.folder || '';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push(s);
  }
  const folderNames = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const nodes: HTMLElement[] = [];
  for (const f of folderNames) {
    const items = groups.get(f)!.sort((a, b) => a.name.localeCompare(b.name));
    const collapsed = !q && state.collapsed.has(f);
    if (f) {
      const head = el('div', { class: `tree-folder${collapsed ? ' collapsed' : ''}` }, el('span', { class: 'chev' }, '▾'), icon('folder', 14), el('span', {}, f), el('span', { class: 'count' }, String(items.length)));
      head.addEventListener('click', () => {
        if (state.collapsed.has(f)) state.collapsed.delete(f);
        else state.collapsed.add(f);
        localStorage.setItem('collapsed', JSON.stringify([...state.collapsed]));
        renderSidebar();
      });
      nodes.push(head);
    }
    if (collapsed) continue;
    for (const s of items) {
      const row = el('div', { class: `tree-item${f ? ' nested' : ''}`, title: `${s.notes ? s.notes + '\n' : ''}Doble clic para conectar`, tabindex: '0' },
        el('span', { class: 'kind-badge', style: s.color ? `color:${s.color}` : '' }, icon(kindIcon(s.kind), 14)),
        el('span', { class: 'tree-name' }, s.name),
        el('span', { class: 'tree-sub' }, s.kind === 'local' ? 'local' : s.kind === 'serial' ? s.serialPath || '' : `${s.username ? s.username + '@' : ''}${s.host || ''}`),
      );
      row.addEventListener('dblclick', () => void openSession(s));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void openSession(s);
        if (e.key === 'F2') void editExisting(s);
        if (e.key === 'Delete') void deleteSession(s);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Conectar', action: () => void openSession(s) },
          { label: 'Editar…', action: () => void editExisting(s) },
          { label: 'Duplicar', action: () => void duplicateSession(s) },
          { label: 'Copiar comando ssh', disabled: s.kind !== 'ssh', action: () => void navigator.clipboard.writeText(`ssh ${s.port && s.port !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`) },
          { separator: true, label: '' },
          { label: 'Eliminar', danger: true, action: () => void deleteSession(s) },
        ]);
      });
      nodes.push(row);
    }
  }
  if (!nodes.length) {
    nodes.push(el('div', { class: 'empty' }, state.sessions.length ? 'Sin coincidencias.' : 'Aún no hay sesiones guardadas. Crea una con el botón + o importa tu ~/.ssh/config.'));
  }
  tree.replaceChildren(...nodes);
}

async function reloadSessions(): Promise<void> {
  state.sessions = await api.sessions.list();
  renderSidebar();
  renderWelcome();
}

function editorCtx() {
  return { sessions: state.sessions, macros: state.macros, shells: state.info!.shells, vault: state.vault };
}

async function newSession(initial: Partial<SessionConfig> = {}): Promise<void> {
  await refreshVault();
  const s = await editSession(initial, editorCtx());
  if (s) await reloadSessions();
}

async function editExisting(s: SessionConfig): Promise<void> {
  await refreshVault();
  const out = await editSession(s, editorCtx());
  if (out) await reloadSessions();
}

async function duplicateSession(s: SessionConfig): Promise<void> {
  await api.sessions.save({ ...s, id: '', name: `${s.name} (copia)`, tunnels: s.tunnels?.map((t) => ({ ...t, id: uid() })) }, null);
  await reloadSessions();
}

async function deleteSession(s: SessionConfig): Promise<void> {
  if (!(await confirmDialog('Eliminar sesión', `¿Eliminar "${s.name}" y su credencial guardada?`, 'Eliminar', true))) return;
  await api.sessions.delete(s.id);
  await reloadSessions();
}

// ---------------------------------------------------------------------------
// Barra de herramientas

function updateToolbar(): void {
  $('#btn-multiexec').classList.toggle('active', state.multiExec);
  $('#btn-layout').classList.toggle('active', state.layout !== 'single');
  document.body.classList.toggle('multiexec', state.multiExec);
  $('#btn-record').classList.toggle('recording', !!state.recordingTab);
  $('#btn-record').title = state.recordingTab ? 'Detener grabación de macro' : 'Grabar macro en la pestaña activa';
  const v = $('#btn-vault');
  v.replaceChildren(icon(state.vault.unlocked ? 'unlock' : 'lock'));
  v.classList.toggle('active', state.vault.unlocked);
  v.title = !state.vault.exists ? 'Crear bóveda de credenciales' : state.vault.unlocked ? 'Bóveda desbloqueada (clic para bloquear)' : 'Desbloquear la bóveda';
  $('#btn-sftp').toggleAttribute('disabled', state.active?.session.kind !== 'ssh');
  const tc = state.tunnels.filter((t) => t.state === 'listening').length;
  $('#tunnel-count').textContent = tc ? String(tc) : '';
  $('#status-left').textContent = `${state.tabs.length} pestaña${state.tabs.length === 1 ? '' : 's'}${state.multiExec ? ' · MULTI-EJECUCIÓN ACTIVA' : ''}${state.recordingTab ? ' · ● grabando macro' : ''}`;
}

function toggleMultiExec(): void {
  state.multiExec = !state.multiExec;
  for (const t of state.tabs) t.setBroadcastVisible(state.multiExec);
  updateToolbar();
  toast(state.multiExec ? 'Multi-ejecución activada: lo que escribas se envía a todas las pestañas marcadas.' : 'Multi-ejecución desactivada');
}

async function quickConnect(text: string): Promise<void> {
  const p = parseQuickConnect(text);
  if (!p) return toast('Formato: usuario@host:puerto (o telnet://host, rdp://host)', 'error');
  const session = { id: `quick-${uid()}`, folder: '', ...p } as SessionConfig;
  await openSession(session);
}

// ---------------------------------------------------------------------------
// Bóveda

async function refreshVault(): Promise<void> {
  state.vault = await api.vault.status();
  updateToolbar();
}

async function vaultDialog(): Promise<void> {
  await refreshVault();
  if (state.vault.unlocked) {
    await api.vault.lock();
    await refreshVault();
    return toast('Bóveda bloqueada');
  }
  if (!state.vault.exists) {
    const p1 = input({ type: 'password' });
    const p2 = input({ type: 'password' });
    const body = el('div', {},
      el('p', {}, 'La bóveda guarda contraseñas y frases de paso cifradas (scrypt + AES-256-GCM) con una contraseña maestra que nunca se almacena. Si la olvidas no se puede recuperar.'),
      field('Contraseña maestra', p1, 'Mínimo 8 caracteres'), field('Repítela', p2));
    await modal('Crear bóveda', body, [
      { label: 'Cancelar', value: false, kind: 'ghost' },
      { label: 'Crear', kind: 'primary', value: async () => {
        if (p1.value !== p2.value) throw new Error('Las contraseñas no coinciden.');
        await api.vault.create(p1.value);
        toast('Bóveda creada y desbloqueada', 'ok');
        return true;
      } },
    ], { dismiss: false });
  } else {
    await unlockDialog();
  }
  await refreshVault();
}

async function unlockDialog(): Promise<boolean> {
  const pw = input({ type: 'password' });
  return modal('Desbloquear bóveda', el('div', {}, el('p', {}, 'Introduce la contraseña maestra para usar las credenciales guardadas.'), field('Contraseña maestra', pw)), [
    { label: 'Ahora no', value: false, kind: 'ghost' },
    { label: 'Desbloquear', kind: 'primary', value: async () => {
      await api.vault.unlock(pw.value);
      await refreshVault();
      return true;
    } },
  ], { dismiss: false });
}

// ---------------------------------------------------------------------------
// Preguntas de seguridad (huella del host y autenticación interactiva)

api.prompts.onHostKey(async (reqId: string, p: HostKeyPrompt & { connId: string }) => {
  const changed = !!p.previous;
  const body = el('div', {},
    changed
      ? el('p', { class: 'danger-text' }, `⚠ ¡LA CLAVE DEL HOST HA CAMBIADO! Podría tratarse de un ataque de intermediario (MITM). Huella anterior: ${p.previous}`)
      : el('p', {}, `Es la primera vez que te conectas a ${p.host}:${p.port}. Comprueba que la huella coincide con la del servidor.`),
    el('pre', { class: 'fingerprint' }, `${p.algorithm}\n${p.fingerprint}`),
  );
  const ok = await modal(changed ? 'Clave de host cambiada' : 'Verificar host', body, [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: changed ? 'Aceptar la nueva clave' : 'Confiar y conectar', value: true, kind: changed ? 'danger' : 'primary' },
  ], { dismiss: false });
  api.prompts.reply(reqId, ok);
});

api.prompts.onAuth(async (reqId: string, p: AuthPrompt) => {
  const inputs = p.prompts.map((q) => input({ type: q.echo ? 'text' : 'password' }));
  const body = el('div', {}, p.instructions ? el('p', {}, p.instructions) : null, ...p.prompts.map((q, i) => field(q.prompt, inputs[i])));
  const res = await modal<string[] | null>(p.title, body, [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    { label: 'Continuar', value: () => inputs.map((i) => i.value), kind: 'primary' },
  ], { dismiss: null });
  api.prompts.reply(reqId, res);
});

// ---------------------------------------------------------------------------
// Macros

async function macrosDialog(): Promise<void> {
  const list = el('div', { class: 'macro-list' });
  const render = () => {
    list.replaceChildren(
      ...(state.macros.length ? state.macros : []).map((m) =>
        el('div', { class: 'macro-row' },
          el('div', { class: 'macro-info' }, el('strong', {}, m.name), el('code', {}, m.body.length > 80 ? m.body.slice(0, 80) + '…' : m.body)),
          el('button', { class: 'btn ghost', title: 'Ejecutar en la pestaña activa (o en todas si la multi-ejecución está activa)', onclick: () => void playMacro(m) }, icon('play', 14), ' Ejecutar'),
          el('button', { class: 'icon-btn', title: 'Editar', onclick: async () => {
            if (await editMacro(m)) render();
          } }, icon('edit', 14)),
          el('button', { class: 'icon-btn', title: 'Eliminar', onclick: async () => {
            if (await confirmDialog('Eliminar macro', `¿Eliminar "${m.name}"?`, 'Eliminar', true)) {
              await api.macros.delete(m.id);
              state.macros = await api.macros.list();
              render();
            }
          } }, icon('trash', 14)),
        )),
      ...(state.macros.length ? [] : [el('div', { class: 'empty' }, 'No hay macros. Crea una o graba lo que escribes con el botón ●.')]),
    );
  };
  render();
  const help = el('small', { class: 'hint' }, 'Sintaxis: texto literal; \\n = Intro, \\t = Tab, \\e = Esc, \\xHH = byte, {sleep:500} = pausa en ms.');
  await modal('Macros', el('div', {}, list, help), [
    { label: 'Nueva macro', kind: 'ghost', value: async () => {
      if (await editMacro({ id: '', name: '', body: '' })) render();
      return undefined;
    } },
    { label: 'Cerrar', value: true, kind: 'primary' },
  ], { wide: true, dismiss: true });
}

async function editMacro(m: Macro): Promise<boolean> {
  const name = input({ value: m.name, placeholder: 'Actualizar sistema' });
  const body = el('textarea', { rows: '6', class: 'mono', spellcheck: 'false', placeholder: 'sudo apt update\\n{sleep:1000}sudo apt -y upgrade\\n' }) as HTMLTextAreaElement;
  body.value = m.body;
  const ok = await modal(m.id ? 'Editar macro' : 'Nueva macro', el('div', {}, field('Nombre', name), field('Contenido', body)), [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: 'Guardar', kind: 'primary', value: async () => {
      if (!name.value.trim()) throw new Error('Pon un nombre a la macro.');
      await api.macros.save({ ...m, name: name.value.trim(), body: body.value });
      state.macros = await api.macros.list();
      return true;
    } },
  ], { dismiss: false });
  return ok;
}

async function playMacro(m: Macro): Promise<void> {
  const targets = state.multiExec ? state.tabs.filter((t) => t.broadcast && t.state === 'connected') : state.active ? [state.active] : [];
  if (!targets.length) return toast('No hay ninguna pestaña conectada donde ejecutar la macro.', 'error');
  const steps = parseMacro(m.body);
  await Promise.all(targets.map((t) => runMacro(steps, (d) => t.write(d))));
}

async function toggleRecording(): Promise<void> {
  if (state.recordingTab) {
    const tab = state.recordingTab;
    const data = tab.recording || '';
    tab.recording = null;
    state.recordingTab = null;
    updateToolbar();
    if (!data) return toast('No se grabó nada.');
    await editMacro({ id: '', name: `Grabada en ${tab.title}`, body: encodeRecording(data) });
    return;
  }
  if (!state.active) return toast('Abre una pestaña para grabar una macro.', 'error');
  state.recordingTab = state.active;
  state.active.recording = '';
  updateToolbar();
  toast('Grabando: todo lo que escribas en esta pestaña se guardará como macro. Pulsa ● de nuevo para terminar.');
}

// ---------------------------------------------------------------------------
// Túneles

async function tunnelsDialog(): Promise<void> {
  state.tunnels = await api.tunnels.list();
  const list = el('div', { class: 'tunnel-status-list' });
  const render = () => {
    list.replaceChildren(
      ...state.tunnels.map((t) => el('div', { class: `tunnel-status ${t.state}` },
        el('span', { class: 'dot' }),
        el('div', { class: 'grow' }, el('strong', {}, t.sessionName || ''), el('div', { class: 'mono' }, t.description), t.error ? el('small', { class: 'danger-text' }, t.error) : el('small', { class: 'hint' }, `${t.activeConnections} conexión(es) activa(s)`)),
        t.state === 'listening'
          ? el('button', { class: 'btn ghost', onclick: async () => {
            await api.tunnels.stop(t.connId, t.tunnelId).catch((e: unknown) => toast(errMsg(e), 'error'));
          } }, icon('stop', 14), ' Detener')
          : el('button', { class: 'btn ghost', onclick: async () => {
            await api.tunnels.start(t.connId, t.tunnelId).catch((e: unknown) => toast(errMsg(e), 'error'));
          } }, icon('play', 14), ' Iniciar'),
      )),
      ...(state.tunnels.length ? [] : [el('div', { class: 'empty' }, 'No hay túneles en las sesiones SSH abiertas. Defínelos en la sesión o añade uno temporal a la pestaña activa.')]),
    );
  };
  render();
  const off = api.tunnels.onChanged((l: typeof state.tunnels) => {
    state.tunnels = l;
    render();
    updateToolbar();
  });
  await modal('Túneles SSH', list, [
    { label: 'Añadir a la pestaña activa…', kind: 'ghost', value: async () => {
      await addTempTunnel();
      return undefined;
    } },
    { label: 'Cerrar', value: true, kind: 'primary' },
  ], { wide: true, dismiss: true });
  off();
}

async function addTempTunnel(): Promise<void> {
  const tab = state.active;
  if (!tab || tab.session.kind !== 'ssh' || tab.state !== 'connected') return toast('La pestaña activa debe ser una sesión SSH conectada.', 'error');
  const type = select([['local', 'Local (-L)'], ['remote', 'Remoto (-R)'], ['dynamic', 'Dinámico SOCKS5 (-D)']]);
  const bh = input({ value: '127.0.0.1' });
  const bp = input({ type: 'number', value: '8080' });
  const dh = input({ value: 'localhost' });
  const dp = input({ type: 'number', value: '80' });
  await modal(`Nuevo túnel en ${tab.title}`, el('div', {}, field('Tipo', type), el('div', { class: 'grid2' }, field('Escuchar en', bh), field('Puerto', bp)), el('div', { class: 'grid2' }, field('Destino', dh), field('Puerto destino', dp))), [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: 'Crear e iniciar', kind: 'primary', value: async () => {
      await api.tunnels.add(tab.connId, { id: '', name: '', type: type.value, bindHost: bh.value, bindPort: Number(bp.value), destHost: dh.value, destPort: Number(dp.value), autoStart: false });
      toast('Túnel iniciado', 'ok');
      return true;
    } },
  ], { dismiss: false });
}

// ---------------------------------------------------------------------------
// Ajustes

async function settingsDialog(): Promise<void> {
  const s = state.settings!;
  const theme = select(THEMES.map((t) => [t.id, t.name] as [string, string]), s.theme);
  const fontFamily = input({ value: s.fontFamily });
  const fontSize = input({ type: 'number', value: String(s.fontSize), min: '8', max: '32' });
  const cursorStyle = select([['block', 'Bloque'], ['bar', 'Barra'], ['underline', 'Subrayado']], s.cursorStyle);
  const scrollback = input({ type: 'number', value: String(s.scrollback), min: '100', step: '1000' });
  const blink = checkbox('Cursor parpadeante', s.cursorBlink);
  const cos = checkbox('Copiar al seleccionar', s.copyOnSelect);
  const rcp = checkbox('Pegar con clic derecho', s.rightClickPaste);
  const coc = checkbox('Confirmar al cerrar pestañas remotas', s.confirmOnClose);
  const shell = select([['', 'Automático'], ...state.info!.shells.map((x) => [x.id, x.name] as [string, string])], s.defaultLocalShell);
  const rdp = input({ value: s.rdpClient, placeholder: 'Vacío = visor integrado (o mstsc / xfreerdp)' });
  const vnc = input({ value: s.vncClient, placeholder: 'vncviewer' });
  const autolock = input({ type: 'number', value: String(s.vaultAutoLockMin), min: '0' });
  const logAll = checkbox('Guardar un registro de todas las sesiones', s.logAllSessions);
  const logStrip = checkbox('Quitar colores y códigos de control del registro', s.logStripAnsi);
  const logDir = input({ value: s.logDir, placeholder: 'Por defecto: carpeta de datos/logs' });
  const autoRe = checkbox('Reconectar automáticamente las sesiones SSH/Telnet caídas', s.autoReconnect);
  theme.addEventListener('change', () => applyUiTheme(themeById(theme.value)));

  const body = el('div', { class: 'session-form' },
    el('fieldset', {}, el('legend', {}, 'Apariencia'),
      el('div', { class: 'grid3' }, field('Tema', theme), field('Tamaño de letra', fontSize), field('Cursor', cursorStyle)),
      field('Tipografía', fontFamily), blink.wrap),
    el('fieldset', {}, el('legend', {}, 'Terminal'),
      el('div', { class: 'grid2' }, field('Líneas de historial', scrollback), field('Shell local por defecto', shell)),
      cos.wrap, rcp.wrap, coc.wrap, autoRe.wrap),
    el('fieldset', {}, el('legend', {}, 'Registro de sesiones'),
      logAll.wrap, logStrip.wrap,
      el('div', { class: 'row' }, field('Carpeta de registros', logDir),
        el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
          const d = await api.pickDir('Carpeta de registros', logDir.value || undefined);
          if (d) logDir.value = d;
        } }, 'Elegir…'),
        el('button', { class: 'btn ghost', type: 'button', onclick: async () => void api.openPath(logDir.value || (await api.logsDir())) }, 'Abrir'))),
    el('fieldset', {}, el('legend', {}, 'Clientes externos'), el('div', { class: 'grid2' }, field('Cliente RDP', rdp), field('Cliente VNC', vnc))),
    el('fieldset', {}, el('legend', {}, 'Seguridad'),
      field('Bloquear la bóveda tras (minutos de inactividad, 0 = nunca)', autolock),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => void changeMasterPassword() }, 'Cambiar contraseña maestra…')),
    el('small', { class: 'hint' }, `Datos en: ${state.info!.dataDir}. Para modo portable crea un archivo llamado "portable" junto al ejecutable.`),
  );
  const saved = await modal<Settings | null>('Ajustes', body, [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    { label: 'Guardar', kind: 'primary', value: () => api.settings.save({
      theme: theme.value,
      fontFamily: fontFamily.value,
      fontSize: Number(fontSize.value) || 14,
      cursorStyle: cursorStyle.value as Settings['cursorStyle'],
      scrollback: Number(scrollback.value) || 10000,
      cursorBlink: blink.box.checked,
      copyOnSelect: cos.box.checked,
      rightClickPaste: rcp.box.checked,
      confirmOnClose: coc.box.checked,
      defaultLocalShell: shell.value,
      rdpClient: rdp.value.trim(),
      vncClient: vnc.value.trim(),
      vaultAutoLockMin: Number(autolock.value) || 0,
      logAllSessions: logAll.box.checked,
      logStripAnsi: logStrip.box.checked,
      logDir: logDir.value.trim(),
      autoReconnect: autoRe.box.checked,
    }) },
  ], { wide: true, dismiss: null });
  if (saved) {
    state.settings = saved;
    for (const t of state.tabs) t.applySettings(saved);
  }
  applyUiTheme(themeById(state.settings!.theme));
}

async function changeMasterPassword(): Promise<void> {
  const o = input({ type: 'password' });
  const n1 = input({ type: 'password' });
  const n2 = input({ type: 'password' });
  await modal('Cambiar contraseña maestra', el('div', {}, field('Actual', o), field('Nueva', n1), field('Repite la nueva', n2)), [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: 'Cambiar', kind: 'primary', value: async () => {
      if (n1.value !== n2.value) throw new Error('Las contraseñas nuevas no coinciden.');
      await api.vault.change(o.value, n1.value);
      toast('Contraseña maestra actualizada', 'ok');
      return true;
    } },
  ], { dismiss: false });
  await refreshVault();
}

function zoom(delta: number): void {
  const s = state.settings!;
  s.fontSize = Math.max(8, Math.min(32, s.fontSize + delta));
  for (const t of state.tabs) t.applySettings(s);
  void api.settings.save({ fontSize: s.fontSize });
}

// ---------------------------------------------------------------------------
// Paleta de comandos / apertura rápida (Ctrl+Mayús+K)

async function palette(): Promise<void> {
  type Item = { label: string; sub: string; run: () => void };
  const actions: Item[] = [
    { label: 'Nueva sesión…', sub: 'Acción', run: () => void newSession() },
    { label: 'Terminal local', sub: 'Acción', run: () => void openLocal() },
    { label: 'Multi-ejecución', sub: 'Acción', run: toggleMultiExec },
    ...(Object.keys(LAYOUT_CELLS) as Layout[]).map((l) => ({ label: `Vista: ${LAYOUT_LABEL[l]}`, sub: 'Vista', run: () => setLayout(l) })),
    { label: 'Macros…', sub: 'Acción', run: () => void macrosDialog() },
    { label: 'Túneles SSH…', sub: 'Acción', run: () => void tunnelsDialog() },
    { label: 'Claves SSH (generar / instalar)…', sub: 'Acción', run: () => void openKeys() },
    { label: 'Servidores TFTP / FTP / HTTP / Syslog', sub: 'Acción', run: () => void serversPanel.toggle(true) },
    { label: 'Ajustes…', sub: 'Acción', run: () => void settingsDialog() },
    { label: 'Acerca de Nexus Neo', sub: 'Ayuda', run: () => void aboutDialog(state.info!) },
    { label: 'Importar ~/.ssh/config', sub: 'Acción', run: () => void importSessions('ssh-config') },
    ...state.macros.map((m) => ({ label: `Ejecutar macro: ${m.name}`, sub: 'Macro', run: () => void playMacro(m) })),
    ...state.tabs.map((t) => ({ label: `Ir a pestaña: ${t.title}`, sub: 'Pestaña', run: () => activate(t) })),
  ];
  const sessionItems: Item[] = state.sessions.map((s) => ({ label: s.name, sub: `${s.kind} ${s.host || s.serialPath || ''} ${s.folder}`, run: () => void openSession(s) }));
  const all = [...sessionItems, ...actions];
  const q = input({ placeholder: 'Busca una sesión, pestaña, macro o acción…' });
  const list = el('div', { class: 'palette-list' });
  let sel = 0;
  let results = all;
  const score = (it: Item, query: string) => {
    const hay = `${it.label} ${it.sub}`.toLowerCase();
    let i = 0;
    for (const ch of query) {
      i = hay.indexOf(ch, i);
      if (i < 0) return -1;
      i++;
    }
    return hay.includes(query) ? 2 : 1;
  };
  let close: (() => void) | null = null;
  const render = () => {
    const query = q.value.toLowerCase().trim();
    results = query ? all.map((it) => [it, score(it, query)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it) : all;
    sel = Math.min(sel, Math.max(results.length - 1, 0));
    list.replaceChildren(...results.slice(0, 50).map((it, i) => {
      const row = el('div', { class: `palette-item${i === sel ? ' sel' : ''}` }, el('span', {}, it.label), el('small', {}, it.sub));
      row.addEventListener('click', () => {
        close?.();
        it.run();
      });
      return row;
    }));
  };
  q.addEventListener('input', () => {
    sel = 0;
    render();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') sel = Math.min(sel + 1, results.length - 1);
    else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const it = results[sel];
      close?.();
      it?.run();
      return;
    } else return;
    e.preventDefault();
    render();
  });
  render();
  await modal<boolean>('Ir a…', el('div', { class: 'palette' }, q, list), [], {
    dismiss: false,
    bind: (c) => (close = () => c(false)),
  });
}

// ---------------------------------------------------------------------------

function openKeys(): Promise<void> {
  const t = state.active;
  return keysDialog(t ? { connId: t.connId, title: t.title, isSsh: t.session.kind === 'ssh' && t.state === 'connected' } : null);
}

async function openLocal(): Promise<void> {
  await openSession({ id: `local-${uid()}`, name: 'Local', folder: '', kind: 'local' });
}

async function importSessions(kind: 'ssh-config' | 'file'): Promise<void> {
  try {
    const r = await api.sessions.import(kind);
    if (r.imported) toast(`${r.imported} sesión(es) importada(s)`, 'ok');
    await reloadSessions();
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function renderWelcome(): void {
  const recent = state.sessions.slice(0, 8);
  $('#welcome').replaceChildren(
    el('div', { class: 'welcome-inner' },
      el('div', { class: 'logo-big' }, logo(64), el('div', {}, el('h1', {}, 'Nexus Neo'), el('p', {}, 'Tu centro de acceso remoto: SSH, SFTP, Telnet, serie, túneles y más.'))),
      el('div', { class: 'welcome-actions' },
        el('button', { class: 'card-btn', onclick: () => void newSession() }, icon('plus', 22), el('strong', {}, 'Nueva sesión'), el('small', {}, 'SSH, Telnet, serie, RDP, VNC…')),
        el('button', { class: 'card-btn', onclick: () => void openLocal() }, icon('terminal', 22), el('strong', {}, 'Terminal local'), el('small', {}, 'Ctrl+Mayús+T')),
        el('button', { class: 'card-btn', onclick: () => void importSessions('ssh-config') }, icon('import', 22), el('strong', {}, 'Importar ~/.ssh/config'), el('small', {}, 'Trae tus hosts existentes')),
        el('button', { class: 'card-btn', onclick: () => void palette() }, icon('search', 22), el('strong', {}, 'Ir a…'), el('small', {}, 'Ctrl+Mayús+K')),
      ),
      recent.length ? el('div', { class: 'welcome-recent' }, el('h3', {}, 'Sesiones'), ...recent.map((s) =>
        el('button', { class: 'recent', onclick: () => void openSession(s) }, icon(kindIcon(s.kind), 14), el('span', {}, s.name), el('small', {}, s.host || s.serialPath || s.kind)))) : null,
      el('div', { class: 'shortcuts' },
        ...[['Ctrl+Mayús+D', 'Vista dividida'], ['Ctrl+Mayús+E', 'Servidores'], ['Ctrl+Mayús+T', 'Terminal local'], ['Ctrl+Mayús+W', 'Cerrar pestaña'], ['Ctrl+Tab', 'Siguiente pestaña'], ['Ctrl+Mayús+M', 'Multi-ejecución'], ['Ctrl+Mayús+F', 'Buscar'], ['Ctrl+Mayús+B', 'Panel lateral'], ['Ctrl+Mayús+S', 'Panel SFTP'], ['Ctrl+ +/-', 'Zoom']]
          .map(([k, d]) => el('div', {}, el('kbd', {}, k), el('span', {}, d)))),
      el('p', { class: 'welcome-foot' },
        `Nexus Neo ${state.info?.version ?? ''} · Hecho por ${AUTHOR} · `,
        el('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void aboutDialog(state.info!); } }, 'Acerca de y aviso legal')),
    ),
  );
}

function buildLayout(): void {
  const qc = el('input', { id: 'quick-connect', placeholder: 'Conexión rápida: usuario@host:22', spellcheck: 'false' });
  qc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && qc.value.trim()) {
      void quickConnect(qc.value);
      qc.value = '';
    }
  });
  const tbtn = (id: string, ico: Parameters<typeof icon>[0], title: string, fn: () => void, extra?: Node) =>
    el('button', { id, class: 'tool-btn', title, onclick: fn }, icon(ico, 18), extra);

  const search = el('input', { class: 'tree-search', placeholder: 'Filtrar sesiones…', spellcheck: 'false' });
  search.addEventListener('input', () => {
    state.filter = search.value;
    renderSidebar();
  });

  document.body.append(
    el('div', { id: 'app' },
      el('header', { id: 'toolbar' },
        el('div', { class: 'brand' }, logo(24), el('span', {}, 'Nexus Neo')),
        tbtn('btn-sidebar', 'sidebar', 'Mostrar/ocultar sesiones (Ctrl+Mayús+B)', () => document.body.classList.toggle('no-sidebar')),
        tbtn('btn-new', 'plus', 'Nueva sesión', () => void newSession()),
        tbtn('btn-local', 'terminal', 'Terminal local (Ctrl+Mayús+T)', () => void openLocal()),
        qc,
        el('div', { class: 'spacer' }),
        tbtn('btn-layout', 'split', 'Vista dividida (Ctrl+Mayús+D)', () => layoutMenu($('#btn-layout'))),
        tbtn('btn-sftp', 'folder', 'Panel SFTP (Ctrl+Mayús+S)', () => void state.active?.toggleSftp()),
        tbtn('btn-multiexec', 'broadcast', 'Multi-ejecución (Ctrl+Mayús+M)', toggleMultiExec),
        tbtn('btn-macros', 'keyboard', 'Macros', () => void macrosDialog()),
        tbtn('btn-record', 'record', 'Grabar macro', () => void toggleRecording()),
        tbtn('btn-tunnels', 'tunnel', 'Túneles SSH', () => void tunnelsDialog(), el('span', { id: 'tunnel-count', class: 'badge' })),
        tbtn('btn-servers', 'server', 'Servidores TFTP / FTP / HTTP / Syslog (Ctrl+Mayús+E)', () => void serversPanel.toggle(), el('span', { id: 'servers-count', class: 'badge' })),
        tbtn('btn-keys', 'key', 'Claves SSH', () => void openKeys()),
        tbtn('btn-vault', 'lock', 'Bóveda', () => void vaultDialog()),
        tbtn('btn-settings', 'settings', 'Ajustes', () => void settingsDialog()),
        tbtn('btn-about', 'info', 'Acerca de Nexus Neo', () => void aboutDialog(state.info!)),
      ),
      el('div', { id: 'main' },
        el('aside', { id: 'sidebar' },
          el('div', { class: 'sidebar-head' }, search,
            el('button', { class: 'icon-btn', title: 'Nueva sesión', onclick: () => void newSession() }, icon('plus', 16))),
          el('div', { id: 'session-tree' }),
          el('div', { class: 'sidebar-foot' },
            el('button', { class: 'icon-btn', title: 'Importar ~/.ssh/config', onclick: () => void importSessions('ssh-config') }, icon('import', 16)),
            el('button', { class: 'icon-btn', title: 'Importar exportación de Nexus Neo', onclick: () => void importSessions('file') }, icon('file', 16)),
            el('button', { class: 'icon-btn', title: 'Exportar sesiones (sin contraseñas)', onclick: async () => {
              if (await api.sessions.export()) toast('Sesiones exportadas', 'ok');
            } }, icon('export', 16)),
          ),
        ),
        el('section', { id: 'workspace' },
          el('nav', { id: 'tabbar' }),
          el('div', { id: 'panes', class: 'layout-single' }, el('div', { id: 'welcome' })),
        ),
        serversPanel.root,
      ),
      el('footer', { id: 'statusbar' }, el('span', { id: 'status-left' }), el('span', { class: 'spacer' }), el('span', { id: 'status-right' })),
    ),
  );
}

function bindShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey && e.shiftKey;
    const k = e.code;
    let handled = true;
    if (mod && k === 'KeyT') void openLocal();
    else if (mod && k === 'KeyW') state.active && void closeTab(state.active);
    else if (mod && k === 'KeyK') void palette();
    else if (mod && k === 'KeyB') document.body.classList.toggle('no-sidebar');
    else if (mod && k === 'KeyM') toggleMultiExec();
    else if (mod && k === 'KeyS') void state.active?.toggleSftp();
    else if (mod && k === 'KeyE') void serversPanel.toggle();
    else if (mod && k === 'KeyD') {
      const order = Object.keys(LAYOUT_CELLS) as Layout[];
      setLayout(order[(order.indexOf(state.layout) + 1) % order.length]);
    }
    else if (e.ctrlKey && e.key === 'Tab') cycleTab(e.shiftKey ? -1 : 1);
    else if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) zoom(1);
    else if (e.ctrlKey && !e.shiftKey && e.key === '-') zoom(-1);
    else if (e.ctrlKey && !e.shiftKey && e.key === '0') zoom(14 - state.settings!.fontSize);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  window.addEventListener('beforeunload', () => {
    for (const t of state.tabs) t.dispose();
  });
}

async function main(): Promise<void> {
  buildLayout();
  bindShortcuts();
  const [info, settings, sessions, macros] = await Promise.all([api.appInfo(), api.settings.get(), api.sessions.list(), api.macros.list()]);
  state.info = info;
  state.settings = settings;
  state.sessions = sessions;
  state.macros = macros;
  document.body.classList.add(`platform-${info.platform}`);
  $('#status-right').textContent = `Nexus Neo ${info.version}`;
  applyUiTheme(themeById(settings.theme));
  renderSidebar();
  renderWelcome();
  if (!(await ensureDisclaimerAccepted(settings))) return;

  api.conn.onData((id: string, data: string) => state.tabs.find((t) => t.connId === id)?.receive(data));
  api.conn.onState((id: string, s: Tab['state'], msg?: string) => state.tabs.find((t) => t.connId === id)?.setState(s, msg));
  api.tunnels.onChanged((l: typeof state.tunnels) => {
    state.tunnels = l;
    updateToolbar();
  });
  api.vault.onLocked(() => {
    void refreshVault();
    toast('La bóveda se ha bloqueado por inactividad');
  });

  serversPanel.onStatusChange = (n) => {
    $('#servers-count').textContent = n ? String(n) : '';
    $('#btn-servers').classList.toggle('active', n > 0);
  };

  await refreshVault();
  if (state.vault.exists && !state.vault.unlocked) await unlockDialog();
  await refreshVault();
}

void main();
