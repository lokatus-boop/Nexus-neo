// Panel lateral de servidores integrados (TFTP, FTP, HTTP, Syslog).
import { api } from './api';
import { el, icon, toast, errMsg, input, checkbox } from './ui';
import type { NetInterfaceInfo, ServerConfig, ServerLogEntry, ServerStatus } from '../shared/types';

type Cfg = ServerConfig & { hasPassword?: boolean };

const KIND_HINT: Record<ServerConfig['kind'], string> = {
  tftp: 'Firmware y copias de configuración de switches, routers y teléfonos IP.',
  ftp: 'Transferencias con usuario y contraseña o anónimas.',
  http: 'Sirve una carpeta por HTTP (descargas de imágenes, PUT opcional).',
  syslog: 'Recibe los logs que envían tus equipos de red.',
};

const SEV_CLASS = ['sev-crit', 'sev-crit', 'sev-crit', 'sev-err', 'sev-warn', 'sev-notice', 'sev-info', 'sev-debug'];

export class ServersPanel {
  readonly root: HTMLElement;
  private configs: Cfg[] = [];
  private status = new Map<string, ServerStatus>();
  private logs: ServerLogEntry[] = [];
  private interfaces: NetInterfaceInfo[] = [];
  private vaultUnlocked = false;
  private cardsEl: HTMLElement;
  private logEl: HTMLElement;
  private ipsEl: HTMLElement;
  private filter = 'all';
  private expanded = new Set<string>();
  private loaded = false;
  onStatusChange: (running: number) => void = () => undefined;

  constructor() {
    this.cardsEl = el('div', { class: 'srv-cards' });
    this.logEl = el('div', { class: 'srv-log' });
    this.ipsEl = el('div', { class: 'srv-ips' });
    const filters = el('div', { class: 'srv-filters' });
    for (const [id, label] of [['all', 'Todo'], ['tftp', 'TFTP'], ['ftp', 'FTP'], ['http', 'HTTP'], ['syslog', 'Syslog']]) {
      filters.append(el('button', { class: `chip${id === 'all' ? ' active' : ''}`, 'data-f': id, onclick: () => {
        this.filter = id;
        filters.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', (c as HTMLElement).dataset.f === id));
        this.renderLog();
      } }, label));
    }
    this.root = el('aside', { id: 'servers-panel', class: 'hidden' },
      el('div', { class: 'srv-head' }, el('h3', {}, 'Servidores'),
        el('button', { class: 'icon-btn', title: 'Cerrar', onclick: () => this.toggle(false) }, icon('x', 14))),
      this.ipsEl,
      this.cardsEl,
      el('div', { class: 'srv-log-head' }, filters,
        el('button', { class: 'icon-btn', title: 'Vaciar registro', onclick: async () => {
          await api.servers.clearLogs();
          this.logs = [];
          this.renderLog();
        } }, icon('trash', 14))),
      this.logEl,
    );
    api.servers.onStatus((list: ServerStatus[]) => {
      for (const s of list) this.status.set(s.id, s);
      this.renderCards();
    });
    api.servers.onLog((e: ServerLogEntry) => {
      this.logs.push(e);
      if (this.logs.length > 2000) this.logs.shift();
      if (!this.root.classList.contains('hidden')) this.appendLog(e);
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  async toggle(show?: boolean): Promise<void> {
    const v = show ?? !this.visible;
    this.root.classList.toggle('hidden', !v);
    document.body.classList.toggle('servers-open', v);
    if (v) await this.reload();
    window.dispatchEvent(new Event('resize'));
  }

  async reload(): Promise<void> {
    const data = await api.servers.list();
    this.configs = data.configs;
    this.status = new Map((data.status as ServerStatus[]).map((s) => [s.id, s]));
    this.logs = data.logs;
    this.interfaces = data.interfaces;
    this.vaultUnlocked = data.vaultUnlocked;
    this.loaded = true;
    this.renderIps();
    this.renderCards();
    this.renderLog();
  }

  runningCount(): number {
    return [...this.status.values()].filter((s) => s.running).length;
  }

  private renderIps(): void {
    const v4 = this.interfaces.filter((i) => i.family === 'IPv4');
    this.ipsEl.replaceChildren(
      el('span', { class: 'hint' }, 'IPs de este equipo:'),
      ...(v4.length ? v4 : this.interfaces).map((i) =>
        el('button', { class: 'chip mono', title: `${i.name} · clic para copiar`, onclick: () => {
          void navigator.clipboard.writeText(i.address);
          toast(`${i.address} copiada`);
        } }, i.address)),
    );
  }

  private renderCards(): void {
    if (!this.loaded) return;
    this.cardsEl.replaceChildren(...this.configs.map((c) => this.card(c)));
    this.onStatusChange(this.runningCount());
  }

  private card(c: Cfg): HTMLElement {
    const st = this.status.get(c.id);
    const running = !!st?.running;
    const shownHost = c.bindHost === '0.0.0.0' || c.bindHost === '::' ? this.interfaces.find((i) => i.family === 'IPv4')?.address || c.bindHost : c.bindHost;
    const url = `${c.kind === 'syslog' ? 'udp' : c.kind}://${shownHost}:${c.port}`;
    const toggleBtn = el('button', { class: `btn ${running ? 'danger' : 'primary'} sm`, onclick: async () => {
      toggleBtn.setAttribute('disabled', '');
      try {
        if (running) await api.servers.stop(c.id);
        else await api.servers.start(c.id);
      } catch (e) {
        toast(errMsg(e), 'error', 8000);
      } finally {
        toggleBtn.removeAttribute('disabled');
      }
    } }, icon(running ? 'stop' : 'play', 12), running ? ' Detener' : ' Iniciar');
    const head = el('div', { class: 'srv-card-head' },
      el('span', { class: `dot ${running ? 'on' : st?.error ? 'err' : ''}` }),
      el('div', { class: 'grow' },
        el('strong', {}, c.name),
        el('div', { class: 'mono hint', title: 'Clic para copiar', onclick: () => void navigator.clipboard.writeText(url) },
          url, st?.active ? `  ·  ${st.active} activa(s)` : ''),
      ),
      el('button', { class: 'icon-btn', title: 'Configurar', onclick: () => {
        if (this.expanded.has(c.id)) this.expanded.delete(c.id);
        else this.expanded.add(c.id);
        this.renderCards();
      } }, icon('settings', 14)),
      toggleBtn,
    );
    const card = el('div', { class: `srv-card${running ? ' running' : ''}` }, head);
    if (st?.error && !running) card.append(el('div', { class: 'danger-text small' }, st.error));
    if (this.expanded.has(c.id)) card.append(this.form(c, running));
    return card;
  }

  private form(c: Cfg, running: boolean): HTMLElement {
    const draft: Cfg = { ...c };
    const dirInput = input({ value: c.rootDir });
    const port = input({ type: 'number', value: String(c.port), min: '1', max: '65535', class: 'xs' });
    const bind = el('select') as HTMLSelectElement;
    for (const [v, l] of [['0.0.0.0', 'Todas (IPv4)'], ['::', 'Todas (IPv4+IPv6)'], ...this.interfaces.map((i) => [i.address, `${i.address} (${i.name})`])]) {
      bind.append(el('option', { value: v, selected: v === c.bindHost }, l));
    }
    const write = checkbox(c.kind === 'http' ? 'Permitir subidas (PUT)' : 'Permitir subidas', c.allowWrite);
    const rows: HTMLElement[] = [
      el('small', { class: 'hint' }, KIND_HINT[c.kind]),
      el('label', { class: 'srv-row' }, el('span', {}, c.kind === 'syslog' ? 'Carpeta de logs' : 'Carpeta raíz'),
        el('div', { class: 'row' }, dirInput,
          el('button', { class: 'icon-btn', type: 'button', title: 'Elegir carpeta', onclick: async () => {
            const d = await api.pickDir('Carpeta del servidor', dirInput.value);
            if (d) dirInput.value = d;
          } }, icon('folder', 14)),
          el('button', { class: 'icon-btn', type: 'button', title: 'Abrir en el explorador', onclick: () => void api.openPath(dirInput.value) }, icon('export', 14)))),
      el('div', { class: 'grid2' },
        el('label', { class: 'srv-row' }, el('span', {}, 'Puerto'), port),
        el('label', { class: 'srv-row' }, el('span', {}, 'Escuchar en'), bind)),
    ];
    if (c.kind !== 'syslog') rows.push(write.wrap);

    let user: HTMLInputElement | undefined;
    let pass: HTMLInputElement | undefined;
    let anon: ReturnType<typeof checkbox> | undefined;
    let pmin: HTMLInputElement | undefined;
    let pmax: HTMLInputElement | undefined;
    if (c.kind === 'ftp') {
      user = input({ value: c.username || '' });
      pass = input({ type: 'password', placeholder: c.hasPassword ? '•••••• (guardada)' : 'Contraseña' });
      anon = checkbox('Permitir acceso anónimo', !!c.anonymous);
      pmin = input({ type: 'number', value: String(c.pasvMin ?? 50000) });
      pmax = input({ type: 'number', value: String(c.pasvMax ?? 50100) });
      rows.push(
        el('div', { class: 'grid2' }, el('label', { class: 'srv-row' }, el('span', {}, 'Usuario'), user), el('label', { class: 'srv-row' }, el('span', {}, 'Contraseña'), pass)),
        anon.wrap,
        el('div', { class: 'grid2' }, el('label', { class: 'srv-row' }, el('span', {}, 'Pasivo desde'), pmin), el('label', { class: 'srv-row' }, el('span', {}, 'hasta'), pmax)),
        el('small', { class: 'hint' }, this.vaultUnlocked ? 'La contraseña se guarda cifrada en la bóveda.' : 'Con la bóveda bloqueada la contraseña sólo se recuerda hasta cerrar la app.'),
      );
    }
    let tcp: ReturnType<typeof checkbox> | undefined;
    let toFile: ReturnType<typeof checkbox> | undefined;
    if (c.kind === 'syslog') {
      tcp = checkbox('Escuchar también por TCP', !!c.syslogTcp);
      toFile = checkbox('Guardar en archivo diario', c.syslogToFile !== false);
      rows.push(tcp.wrap, toFile.wrap);
    }
    if (c.port < 1024) rows.push(el('small', { class: 'hint' }, 'En Linux los puertos por debajo de 1024 necesitan permisos especiales: si falla, usa otro (p. ej. 6969 para TFTP o 2121 para FTP) o ejecuta "sudo setcap cap_net_bind_service=+ep" sobre el ejecutable.'));

    const save = el('button', { class: 'btn primary sm', type: 'button', onclick: async () => {
      Object.assign(draft, {
        rootDir: dirInput.value.trim(),
        port: Number(port.value),
        bindHost: bind.value,
        allowWrite: write.box.checked,
      });
      if (c.kind === 'ftp') {
        Object.assign(draft, { username: user!.value.trim(), password: pass!.value || undefined, anonymous: anon!.box.checked, pasvMin: Number(pmin!.value), pasvMax: Number(pmax!.value) });
      }
      if (c.kind === 'syslog') Object.assign(draft, { syslogTcp: tcp!.box.checked, syslogToFile: toFile!.box.checked });
      if (!draft.rootDir) return toast('Indica una carpeta.', 'error');
      if (!(draft.port > 0 && draft.port < 65536)) return toast('Puerto no válido.', 'error');
      try {
        await api.servers.save(draft);
        this.expanded.delete(c.id);
        await this.reload();
        toast(`${c.name} guardado`, 'ok');
      } catch (e) {
        toast(errMsg(e), 'error');
      }
    } }, 'Guardar');
    const form = el('div', { class: 'srv-form' }, ...rows, el('div', { class: 'row end' }, save));
    if (running) {
      form.querySelectorAll('input,select,button').forEach((x) => x.setAttribute('disabled', ''));
      form.prepend(el('small', { class: 'hint' }, 'Detén el servidor para cambiar su configuración.'));
    }
    return form;
  }

  private logLine(e: ServerLogEntry): HTMLElement {
    const kind = this.configs.find((c) => c.id === e.serverId)?.kind || '';
    const t = new Date(e.time).toLocaleTimeString();
    const cls = e.syslog ? SEV_CLASS[e.syslog.severity] : `lvl-${e.level}`;
    return el('div', { class: `log-line ${cls}`, 'data-kind': kind },
      el('span', { class: 'log-time' }, t), el('span', { class: 'log-kind' }, kind.toUpperCase()), el('span', { class: 'log-msg' }, e.message));
  }

  private renderLog(): void {
    const items = this.logs.filter((e) => this.filter === 'all' || this.configs.find((c) => c.id === e.serverId)?.kind === this.filter).slice(-500);
    this.logEl.replaceChildren(...(items.length ? items.map((e) => this.logLine(e)) : [el('div', { class: 'empty' }, 'Sin actividad todavía.')]));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private appendLog(e: ServerLogEntry): void {
    const kind = this.configs.find((c) => c.id === e.serverId)?.kind;
    if (this.filter !== 'all' && kind !== this.filter) return;
    this.logEl.querySelector('.empty')?.remove();
    const atBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
    this.logEl.append(this.logLine(e));
    while (this.logEl.childElementCount > 500) this.logEl.firstElementChild?.remove();
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
