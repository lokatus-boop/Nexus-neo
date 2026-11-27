// Operaciones de red: despliegue masivo de órdenes o firmware, plantillas de configuración y
// respaldos de configuraciones (con historial, comparación y programación).
import { api } from './api';
import { el, field, input, select, checkbox, modal, toast, errMsg, icon } from './ui';
import { devicesFromCsv, lineDiff, parseCsv, renderTemplate, templateVars } from '../shared/template';
import type { BackupEntry, ConfigTemplate, DeployJob, DeviceRunResult, JobProgress, NetDevice, Settings } from '../shared/types';

type Vendor = { id: string; label: string; command: string };
type Tab = 'deploy' | 'templates' | 'backups';

const STATUS_LABEL: Record<DeviceRunResult['status'], string> = { pending: 'En cola', running: 'En curso', ok: 'Correcto', error: 'Error', cancelled: 'Cancelado' };

// Último progreso de cada trabajo (llega antes incluso de que se devuelva su id).
const progress = new Map<string, JobProgress>();
const listeners = new Set<(p: JobProgress) => void>();
let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  api.netops.onProgress((p: JobProgress) => {
    progress.set(p.jobId, p);
    for (const l of listeners) l(p);
  });
}

function textarea(value = '', attrs: Record<string, string> = {}): HTMLTextAreaElement {
  const t = el('textarea', { class: 'mono', spellcheck: 'false', rows: '8', ...attrs });
  t.value = value;
  return t;
}

// --- Selector de equipos --------------------------------------------------------

interface DevicePicker {
  root: HTMLElement;
  devices(): NetDevice[];
  checkedSessions(): { sessionId: string; vendor: string }[];
  setCsv(text: string): void;
  appendCsv(text: string): void;
}

async function devicePicker(vendors: Vendor[] | null, preselect: { sessionId: string; vendor: string }[] = []): Promise<DevicePicker> {
  const saved = (await api.netops.sessionDevices()) as NetDevice[];
  const rows = saved.map((d) => {
    const pre = preselect.find((p) => p.sessionId === d.id);
    const box = el('input', { type: 'checkbox', checked: !!pre });
    const vendor = vendors ? select(vendors.map((v) => [v.id, v.label] as [string, string]), pre?.vendor || vendors[0].id) : null;
    const row = el('label', { class: 'np-dev' }, box, el('span', { class: 'np-name' }, d.name), el('span', { class: 'np-host' }, `${d.protocol} · ${d.host}`), vendor);
    return { d, box, vendor, row };
  });
  const filter = input({ placeholder: 'Filtrar equipos…', class: 'np-filter' });
  filter.addEventListener('input', () => {
    const q = filter.value.toLowerCase();
    for (const r of rows) r.row.style.display = !q || `${r.d.name} ${r.d.host}`.toLowerCase().includes(q) ? '' : 'none';
  });
  const all = el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
    const visible = rows.filter((r) => r.row.style.display !== 'none');
    const on = !visible.every((r) => r.box.checked);
    for (const r of visible) r.box.checked = on;
  } }, 'Todos / ninguno');
  const csv = textarea('', { rows: '4', placeholder: vendors ? 'name,host,protocol,vendor\nsw-acceso-1,10.0.0.11,ssh,cisco-ios' : 'name,host,protocol,vlan\nsw-acceso-1,10.0.0.11,ssh,20' });
  const load = el('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
    const t = (await api.netops.pickCsv()) as string | null;
    if (t != null) csv.value = t;
  } }, 'Cargar CSV…');
  const root = el('div', { class: 'np-picker' },
    el('div', { class: 'row' }, filter, all),
    el('div', { class: 'np-list' }, ...(rows.length ? rows.map((r) => r.row) : [el('p', { class: 'hint' }, 'No hay sesiones SSH o Telnet guardadas. Añade equipos con el CSV de abajo.')])),
    field('Más equipos (CSV)', csv, `Columnas: name, host, protocol (ssh o telnet), port, username${vendors ? ', vendor (perfil)' : ''}. Cualquier otra columna es una variable del equipo: {{vlan}}, {{ip_gestion}}…`),
    el('div', { class: 'row end' }, load),
  );
  return {
    root,
    devices() {
      const out: NetDevice[] = rows.filter((r) => r.box.checked).map((r) => ({ ...r.d, vendor: r.vendor?.value }));
      const extra = devicesFromCsv(csv.value);
      if (vendors) for (const d of extra) if (d.vendor && !vendors.some((v) => v.id === d.vendor)) throw new Error(`Perfil de fabricante desconocido en el CSV: «${d.vendor}». Válidos: ${vendors.map((v) => v.id).join(', ')}`);
      return [...out, ...extra];
    },
    checkedSessions: () => rows.filter((r) => r.box.checked).map((r) => ({ sessionId: r.d.id, vendor: r.vendor?.value || '' })),
    setCsv: (t) => (csv.value = t),
    appendCsv: (t) => (csv.value = csv.value.trim() ? `${csv.value.trim()}\n${t.split('\n').slice(1).join('\n')}` : t),
  };
}

// --- Opciones de conexión comunes -------------------------------------------------

function connOptions(defaults: { timeout: number; concurrency: number }) {
  const user = input({ placeholder: 'Para equipos sin sesión guardada', autocomplete: 'off' });
  const pass = input({ type: 'password', autocomplete: 'new-password' });
  const enable = input({ type: 'password', placeholder: 'Si hay que entrar en modo enable', autocomplete: 'new-password' });
  const concurrency = input({ type: 'number', min: '1', max: '50', value: String(defaults.concurrency) });
  const timeout = input({ type: 'number', min: '5', value: String(defaults.timeout) });
  const prompt = input({ placeholder: 'Automático (termina en #, >, $ o ])' });
  const accept = checkbox('Aceptar automáticamente las huellas SSH de equipos nuevos (nunca las que han cambiado)', false);
  const root = el('details', { class: 'np-adv' }, el('summary', {}, 'Credenciales y opciones de conexión'),
    el('div', { class: 'grid2' }, field('Usuario', user), field('Contraseña', pass)),
    el('div', { class: 'grid2' }, field('Contraseña de enable', enable), field('Prompt (expresión regular)', prompt)),
    el('div', { class: 'grid2' }, field('Equipos a la vez', concurrency), field('Tiempo máximo por orden (s)', timeout)),
    accept.wrap,
    el('p', { class: 'hint' }, 'Los equipos que vienen de una sesión guardada usan su usuario, su clave y la contraseña de la bóveda.'),
  );
  return {
    root,
    read: () => ({
      credentials: user.value || pass.value ? { username: user.value.trim() || undefined, password: pass.value || undefined } : undefined,
      enablePassword: enable.value || undefined,
      concurrency: Math.max(1, Math.min(50, Number(concurrency.value) || 5)),
      timeoutSec: Math.max(5, Number(timeout.value) || 30),
      prompt: prompt.value.trim() || undefined,
      acceptNewHostKeys: accept.box.checked,
    }),
  };
}

// --- Vista de resultados -----------------------------------------------------------

function resultsView(jobId: string, onDone?: (p: JobProgress) => void): { root: HTMLElement; dispose(): void } {
  const tbody = el('tbody');
  const out = el('pre', { class: 'np-output' }, 'Elige un equipo para ver su salida.');
  const summary = el('p', { class: 'hint', id: 'np-summary' }, 'Iniciando…');
  let selected = '';
  let finished = false;
  const cancel = el('button', { class: 'btn ghost small', type: 'button', onclick: () => void api.netops.cancel(jobId) }, 'Cancelar los pendientes');
  const openDir = el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
    const p = progress.get(jobId);
    if (p) void api.openPath(p.dir);
  } }, 'Abrir carpeta de resultados');
  const render = (p: JobProgress) => {
    if (p.jobId !== jobId) return;
    tbody.replaceChildren(...p.results.map((r) => el('tr', { class: `np-${r.status}${r.deviceId === selected ? ' sel' : ''}`, 'data-device': r.name, onclick: () => {
      selected = r.deviceId;
      render(progress.get(jobId)!);
    } },
      el('td', {}, r.name), el('td', {}, r.host), el('td', {}, el('span', { class: `np-st np-st-${r.status}` }, STATUS_LABEL[r.status])),
      el('td', {}, r.message || ''), el('td', {}, r.startedAt && r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)} s` : ''))));
    const sel = p.results.find((r) => r.deviceId === selected);
    if (sel) {
      const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
      out.textContent = sel.output || '(sin salida todavía)';
      if (atEnd) out.scrollTop = out.scrollHeight;
    }
    const n = (s: DeviceRunResult['status']) => p.results.filter((r) => r.status === s).length;
    summary.textContent = `${p.done ? 'Terminado' : 'En curso'}: ${n('ok')} correctos, ${n('error')} con error, ${n('running')} en curso, ${n('pending')} en cola${n('cancelled') ? `, ${n('cancelled')} cancelados` : ''}.`;
    if (p.done && !finished) {
      finished = true;
      cancel.remove();
      onDone?.(p);
    }
  };
  listeners.add(render);
  const cur = progress.get(jobId);
  if (cur) render(cur);
  const root = el('div', { class: 'np-results' },
    summary,
    el('div', { class: 'np-table-wrap' }, el('table', { class: 'np-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Equipo'), el('th', {}, 'Host'), el('th', {}, 'Estado'), el('th', {}, 'Mensaje'), el('th', {}, 'Tiempo'))), tbody)),
    out,
    el('div', { class: 'row end' }, cancel, openDir),
  );
  return { root, dispose: () => listeners.delete(render) };
}

// --- Despliegue -----------------------------------------------------------------

const DEPLOY_HELP = 'Una orden por línea. Variables: {{host}}, {{name}}, {{user}}, {{date}}, {{datetime}}, {{tftp}} (la IP de este equipo), {{file}} (archivo subido) y las columnas del CSV; {{var | valor}} da un valor por defecto. Directivas: «!espera 5», «!intro», «!enviar texto», «!timeout 600». Las líneas con # son comentarios. Si el equipo pregunta ([confirm], [y/n]…), la línea siguiente es la respuesta.';

interface DeployTab {
  root: HTMLElement;
  load(t: { name: string; commands: string; csv?: string }): void;
}

async function deployTab(): Promise<DeployTab> {
  const name = input({ value: 'despliegue', placeholder: 'Nombre del trabajo' });
  const picker = await devicePicker(null);
  const commands = textarea('', { rows: '9', placeholder: 'configure terminal\ninterface vlan {{vlan}}\n description Gestión {{name}}\nend\nwrite memory' });
  const doUpload = checkbox('Subir antes un archivo a cada equipo (firmware, configuración…)', false);
  const localPath = input({ placeholder: 'Archivo local' });
  const pick = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    const f = (await api.netops.pickUpload()) as string | null;
    if (f) localPath.value = f;
  } }, 'Elegir…');
  const remotePath = input({ placeholder: 'flash:/  ·  /tmp/  ·  bootflash:{{file}}' });
  const method = select([['scp', 'SCP (switches y routers)'], ['sftp', 'SFTP']], 'scp');
  const uploadBox = el('div', { class: 'np-upload' }, el('div', { class: 'row' }, field('Archivo', localPath), pick), el('div', { class: 'grid2' }, field('Destino en el equipo', remotePath, 'Carpeta (acabada en / o :) o ruta completa. Admite variables.'), field('Método', method)));
  const toggleUpload = () => (uploadBox.style.display = doUpload.box.checked ? '' : 'none');
  doUpload.box.addEventListener('change', toggleUpload);
  toggleUpload();
  const stopOnError = checkbox('Parar en un equipo cuando una orden falle', true);
  const errorPattern = input({ placeholder: 'Por defecto: «% Invalid input», «Error:», «command not found»…' });
  const opts = connOptions({ timeout: 30, concurrency: 10 });
  const form = el('div', { class: 'session-form' },
    field('Nombre', name),
    el('h3', {}, 'Equipos'), picker.root,
    el('h3', {}, 'Órdenes'), field('Órdenes', commands, DEPLOY_HELP),
    doUpload.wrap, uploadBox,
    stopOnError.wrap,
    field('Expresión de error', errorPattern),
    opts.root,
  );
  const resultsHolder = el('div');
  const run = el('button', { class: 'btn primary', type: 'button', id: 'np-run-deploy', onclick: async () => {
    try {
      const devices = picker.devices();
      if (!devices.length) throw new Error('Elige al menos un equipo.');
      if (doUpload.box.checked && (!localPath.value || !remotePath.value)) throw new Error('Indica el archivo y el destino de la subida.');
      if (errorPattern.value) new RegExp(errorPattern.value);
      const job: DeployJob = {
        name: name.value.trim() || 'despliegue',
        devices,
        commands: commands.value,
        upload: doUpload.box.checked ? { localPath: localPath.value, remotePath: remotePath.value.trim(), method: method.value as 'scp' | 'sftp' } : undefined,
        stopOnError: stopOnError.box.checked,
        errorPattern: errorPattern.value.trim() || undefined,
        ...opts.read(),
      };
      const jobId = (await api.netops.deploy(job)) as string;
      const v = resultsView(jobId, (p) => {
        const bad = p.results.filter((r) => r.status === 'error').length;
        toast(bad ? `Despliegue terminado: ${bad} equipo(s) con error` : 'Despliegue terminado sin errores', bad ? 'error' : 'ok');
      });
      resultsHolder.replaceChildren(el('h3', {}, 'Resultados'), v.root);
      v.root.scrollIntoView({ block: 'start' });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, icon('play'), ' Ejecutar en los equipos');
  return {
    root: el('div', {}, form, el('div', { class: 'row end' }, run), resultsHolder),
    load(t) {
      name.value = t.name;
      commands.value = t.commands;
      if (t.csv) picker.setCsv(t.csv);
    },
  };
}

// --- Plantillas -------------------------------------------------------------------

async function templatesTab(vendors: Vendor[], toDeploy: (t: { name: string; commands: string; csv?: string }) => void): Promise<HTMLElement> {
  let list = (await api.templates.list()) as ConfigTemplate[];
  let current: ConfigTemplate = list[0] || { id: '', name: '', body: '' };
  const listEl = el('div', { class: 'np-tpl-list' });
  const name = input({ placeholder: 'Nombre de la plantilla' });
  const vendor = select([['', '— Cualquiera —'], ...vendors.map((v) => [v.id, v.label] as [string, string])]);
  const desc = input({ placeholder: 'Para qué sirve (opcional)' });
  const body = textarea('', { rows: '12', placeholder: 'hostname {{name}}\n!\ninterface Vlan{{vlan_gestion | 10}}\n ip address {{ip}} {{mascara | 255.255.255.0}}\n!\nip default-gateway {{gateway}}' });
  const varsEl = el('p', { class: 'hint', id: 'np-tpl-vars' });
  const csv = textarea('', { rows: '4', placeholder: 'name,host,ip,gateway\nsw-acceso-1,10.0.0.11,10.0.10.11,10.0.10.1' });
  const rowSel = select([]);
  const preview = el('pre', { class: 'np-output', id: 'np-tpl-preview' });
  const updatePreview = () => {
    const vars = templateVars(body.value);
    varsEl.textContent = vars.length ? `Variables: ${vars.map((v) => `{{${v}}}`).join(' ')}` : 'Sin variables. Escribe {{nombre}} donde vaya un valor que cambie por equipo.';
    const rows = parseCsv(csv.value).rows;
    const prev = rowSel.value;
    rowSel.replaceChildren(...(rows.length ? rows.map((r, i) => el('option', { value: String(i) }, r.name || r.nombre || r.host || `Fila ${i + 1}`)) : [el('option', { value: '' }, 'Sin valores (CSV vacío)')]));
    if (prev && Number(prev) < rows.length) rowSel.value = prev;
    const r = renderTemplate(body.value, rows[Number(rowSel.value) || 0] || {});
    preview.textContent = r.text || ' ';
    if (r.missing.length) preview.append(el('span', { class: 'danger-text' }, `\n\nFaltan: ${r.missing.join(', ')}`));
  };
  for (const e of [body, csv]) e.addEventListener('input', updatePreview);
  rowSel.addEventListener('change', updatePreview);
  const show = (t: ConfigTemplate) => {
    current = t;
    name.value = t.name;
    vendor.value = t.vendor || '';
    desc.value = t.description || '';
    body.value = t.body;
    renderList();
    updatePreview();
  };
  const renderList = () => {
    listEl.replaceChildren(
      ...list.map((t) => el('button', { class: `np-tpl${t.id === current.id ? ' active' : ''}`, type: 'button', onclick: () => show(t) }, t.name, t.vendor ? el('small', {}, vendors.find((v) => v.id === t.vendor)?.label || t.vendor) : null)),
      el('button', { class: 'btn ghost small', type: 'button', onclick: () => show({ id: '', name: '', body: '' }) }, icon('plus'), ' Nueva plantilla'),
    );
  };
  const read = (): ConfigTemplate => {
    if (!name.value.trim()) throw new Error('Ponle un nombre a la plantilla.');
    return { ...current, name: name.value.trim(), vendor: vendor.value || undefined, description: desc.value.trim() || undefined, body: body.value };
  };
  const save = el('button', { class: 'btn primary', type: 'button', id: 'np-tpl-save', onclick: async () => {
    try {
      const t = (await api.templates.save(read())) as ConfigTemplate;
      list = (await api.templates.list()) as ConfigTemplate[];
      show(t);
      toast('Plantilla guardada', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, 'Guardar');
  const del = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    if (!current.id) return;
    await api.templates.delete(current.id);
    list = (await api.templates.list()) as ConfigTemplate[];
    show(list[0] || { id: '', name: '', body: '' });
  } }, 'Eliminar');
  const exp = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    try {
      const r = (await api.templates.export(read(), csv.value)) as { dir: string; files: string[]; missing: Record<string, string[]> } | null;
      if (!r) return;
      const miss = Object.keys(r.missing);
      toast(`${r.files.length} configuraciones guardadas en ${r.dir}${miss.length ? `. Con variables sin valor: ${miss.join(', ')}` : ''}`, miss.length ? 'error' : 'ok', 7000);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, 'Generar archivos .cfg…');
  const send = el('button', { class: 'btn ghost', type: 'button', onclick: () => {
    try {
      const t = read();
      toDeploy({ name: t.name, commands: t.body, csv: csv.value.trim() || undefined });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, icon('play'), ' Aplicar con el despliegue');
  renderList();
  show(current);
  return el('div', { class: 'np-tpl-wrap' },
    listEl,
    el('div', { class: 'session-form' },
      el('div', { class: 'grid2' }, field('Nombre', name), field('Fabricante', vendor)),
      field('Descripción', desc),
      field('Plantilla', body), varsEl,
      field('Valores por equipo (CSV)', csv, 'Una fila por equipo. Si incluye la columna host, «Aplicar con el despliegue» la usa como lista de equipos.'),
      el('div', { class: 'row' }, field('Vista previa de', rowSel)),
      preview,
      el('div', { class: 'row end' }, del, exp, send, save),
    ),
  );
}

// --- Respaldos ----------------------------------------------------------------------

function diffView(a: string, b: string): HTMLElement {
  const lines = lineDiff(a, b);
  const changed = lines.filter((l) => l.op !== ' ').length;
  const pre = el('pre', { class: 'np-diff' });
  // Muestra sólo el contexto alrededor de los cambios (3 líneas).
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.op !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k);
  });
  let last = -1;
  lines.forEach((l, i) => {
    if (!keep.has(i)) return;
    if (last >= 0 && i > last + 1) pre.append(el('span', { class: 'np-diff-gap' }, '…\n'));
    pre.append(el('span', { class: l.op === '+' ? 'np-add' : l.op === '-' ? 'np-del' : '' }, `${l.op} ${l.text}\n`));
    last = i;
  });
  if (!changed) pre.textContent = 'Las dos versiones son idénticas.';
  return el('div', {}, el('p', { class: 'hint' }, `${lines.filter((l) => l.op === '+').length} líneas añadidas, ${lines.filter((l) => l.op === '-').length} eliminadas.`), pre);
}

async function backupsTab(vendors: Vendor[], settings: Settings, vaultUnlocked: boolean): Promise<HTMLElement> {
  const sched = settings.backupSchedule;
  const picker = await devicePicker(vendors, sched.devices);
  const command = input({ placeholder: 'Por defecto, la del perfil (show running-config, display current-configuration…)' });
  const opts = connOptions({ timeout: 60, concurrency: 5 });
  const resultsHolder = el('div');
  const history = el('div', { class: 'np-history' });

  const refreshHistory = async () => {
    const { dir, devices } = (await api.netops.backups()) as { dir: string; devices: { device: string; count: number; last: number }[] };
    const versions = el('div', { class: 'np-versions' }, el('p', { class: 'hint' }, 'Elige un equipo.'));
    const viewer = el('div', { class: 'np-viewer' });
    const showDevice = async (device: string) => {
      const list = (await api.netops.deviceBackups(device)) as BackupEntry[];
      const a = select(list.map((b) => [b.file, new Date(b.time).toLocaleString()] as [string, string]), list[1]?.file || list[0]?.file);
      const b = select(list.map((x) => [x.file, new Date(x.time).toLocaleString()] as [string, string]), list[0]?.file);
      const view = el('button', { class: 'btn ghost small', type: 'button', onclick: async () => viewer.replaceChildren(el('pre', { class: 'np-output' }, (await api.netops.readBackup(b.value)) as string)) }, 'Ver');
      const cmp = el('button', { class: 'btn ghost small', type: 'button', id: 'np-compare', onclick: async () => {
        const [ta, tb] = await Promise.all([api.netops.readBackup(a.value), api.netops.readBackup(b.value)]);
        viewer.replaceChildren(diffView(ta as string, tb as string));
      } }, 'Comparar');
      versions.replaceChildren(el('p', {}, el('b', {}, device), ` · ${list.length} versiones`), el('div', { class: 'grid2' }, field('Versión anterior', a), field('Versión nueva', b)), el('div', { class: 'row end' }, view, cmp));
      viewer.replaceChildren();
    };
    history.replaceChildren(
      el('div', { class: 'row' }, el('p', { class: 'hint', style: 'flex:1' }, `Carpeta: ${dir}`), el('button', { class: 'btn ghost small', type: 'button', onclick: () => void api.openPath(dir) }, 'Abrir carpeta')),
      devices.length
        ? el('div', { class: 'np-dev-backups' }, ...devices.map((d) => el('button', { class: 'np-tpl', type: 'button', onclick: () => void showDevice(d.device) }, d.device, el('small', {}, `${d.count} · ${new Date(d.last).toLocaleString()}`))))
        : el('p', { class: 'hint' }, 'Todavía no hay respaldos.'),
      versions,
      viewer,
    );
  };

  const run = el('button', { class: 'btn primary', type: 'button', id: 'np-run-backup', onclick: async () => {
    try {
      const devices = picker.devices();
      if (!devices.length) throw new Error('Elige al menos un equipo.');
      const jobId = (await api.netops.backup({ name: 'respaldo', devices, command: command.value.trim() || undefined, ...opts.read() })) as string;
      const v = resultsView(jobId, (p) => {
        const changed = p.results.filter((r) => r.changed).length;
        toast(`Respaldo terminado: ${changed} configuración(es) nueva(s) o cambiada(s)`, p.results.some((r) => r.status === 'error') ? 'error' : 'ok');
        void refreshHistory();
      });
      resultsHolder.replaceChildren(el('h3', {}, 'Resultados'), v.root);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, icon('download'), ' Respaldar ahora');

  // Programación
  const enabled = checkbox('Respaldar automáticamente los equipos marcados de la lista de sesiones guardadas', sched.enabled);
  const every = input({ type: 'number', min: '1', value: String(sched.everyHours) });
  const sPass = input({ type: 'password', placeholder: 'Sólo si las sesiones no la tienen ya en la bóveda', autocomplete: 'new-password' });
  const sEnable = input({ type: 'password', autocomplete: 'new-password' });
  const saveSched = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    try {
      const devs = picker.checkedSessions();
      if (enabled.box.checked && !devs.length) throw new Error('Marca en la lista los equipos (sesiones guardadas) que quieres respaldar.');
      await api.netops.schedule({ enabled: enabled.box.checked, everyHours: Math.max(1, Number(every.value) || 24), devices: devs }, { password: sPass.value, enablePassword: sEnable.value });
      sPass.value = sEnable.value = '';
      toast(enabled.box.checked ? `Respaldo programado cada ${every.value} h para ${devs.length} equipo(s)` : 'Respaldo programado desactivado', 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } }, 'Guardar programación');
  const schedBox = el('details', { class: 'np-adv' }, el('summary', {}, 'Respaldo programado'),
    enabled.wrap,
    el('div', { class: 'grid2' }, field('Cada (horas)', every), el('div')),
    el('div', { class: 'grid2' }, field('Contraseña', sPass), field('Contraseña de enable', sEnable)),
    el('p', { class: 'hint' }, `Funciona mientras Nexus Neo está abierto y con la bóveda desbloqueada (las contraseñas se guardan en ella)${vaultUnlocked ? '' : '. Ahora la bóveda está bloqueada'}. Sólo se guarda una copia nueva si la configuración ha cambiado.${sched.lastRun ? ` Último: ${new Date(sched.lastRun).toLocaleString()}.` : ''}`),
    el('div', { class: 'row end' }, saveSched),
  );
  void refreshHistory();
  return el('div', {},
    el('div', { class: 'session-form' },
      el('p', {}, 'Guarda la configuración de tus equipos con fecha. Elige el perfil de fabricante de cada uno: desactiva la paginación y lee la configuración con su orden. Sólo se guarda una versión nueva si ha cambiado algo.'),
      el('h3', {}, 'Equipos'), picker.root,
      field('Orden propia (opcional)', command),
      opts.root,
      schedBox,
    ),
    el('div', { class: 'row end' }, run),
    resultsHolder,
    el('h3', {}, 'Historial'),
    history,
  );
}

// --- Diálogo ------------------------------------------------------------------------

export async function netopsDialog(settings: Settings, vaultUnlocked: boolean, start: Tab = 'deploy'): Promise<void> {
  subscribe();
  const vendors = (await api.netops.vendors()) as Vendor[];
  const panes = new Map<Tab, HTMLElement>();
  const buttons = new Map<Tab, HTMLElement>();
  const select = (t: Tab) => {
    for (const [k, p] of panes) p.style.display = k === t ? '' : 'none';
    for (const [k, b] of buttons) b.classList.toggle('active', k === t);
  };
  const deploy = await deployTab();
  panes.set('deploy', deploy.root);
  panes.set('templates', await templatesTab(vendors, (t) => {
    deploy.load(t);
    select('deploy');
    toast('Plantilla cargada en el despliegue. Revisa los equipos y pulsa Ejecutar.', 'info');
  }));
  panes.set('backups', await backupsTab(vendors, settings, vaultUnlocked));
  for (const [k, p] of panes) p.id = `np-pane-${k}`;
  const labels: [Tab, string][] = [['deploy', 'Despliegue masivo'], ['templates', 'Plantillas'], ['backups', 'Respaldos']];
  const tabs = el('div', { class: 'np-tabs', role: 'tablist' }, ...labels.map(([k, l]) => {
    const b = el('button', { class: 'np-tab', type: 'button', role: 'tab', onclick: () => select(k) }, l);
    buttons.set(k, b);
    return b;
  }));
  select(start);
  await modal<boolean>('Operaciones de red', el('div', { class: 'np' }, tabs, ...panes.values()), [{ label: 'Cerrar', value: true, kind: 'ghost' }], { wide: true, dismiss: true });
}
