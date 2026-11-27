// Una pestaña: terminal xterm.js + conexión + panel SFTP opcional + barra de estado.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, uid } from './api';
import { el, icon, errMsg } from './ui';
import { SftpPanel } from './sftp-panel';
import { themeById } from './themes';
import type { ConnState, SessionConfig, Settings } from '../shared/types';

export interface TabHost {
  onInput(tab: Tab, data: string): void;
  onStateChange(tab: Tab): void;
  settings(): Settings;
}

export class Tab {
  readonly connId = uid();
  readonly pane: HTMLElement;
  readonly tabEl: HTMLElement;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  state: ConnState = 'connecting';
  broadcast = true;
  title: string;
  private termHost: HTMLElement;
  private statusEl: HTMLElement;
  private monitorEl: HTMLElement;
  private searchBar: HTMLElement;
  private sftp: SftpPanel | null = null;
  private sftpWrap: HTMLElement;
  private ro: ResizeObserver;
  private monitorTimer: number | undefined;
  private titleEl: HTMLElement;
  private broadcastBox: HTMLInputElement;
  /** Grabación de macro en curso. */
  recording: string | null = null;

  constructor(readonly session: SessionConfig, private readonly host: TabHost) {
    const s = host.settings();
    this.title = session.name;
    this.term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorBlink: s.cursorBlink,
      cursorStyle: s.cursorStyle,
      scrollback: s.scrollback,
      allowProposedApi: true,
      theme: themeById(s.theme).term,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, url) => void api.openExternal(url)));

    this.termHost = el('div', { class: 'term-host' });
    this.statusEl = el('span', { class: 'pane-status' });
    this.monitorEl = el('span', { class: 'pane-monitor' });
    this.sftpWrap = el('div', { class: 'sftp-wrap hidden' });
    const searchInput = el('input', { placeholder: 'Buscar en el terminal…', spellcheck: 'false' });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) this.search.findPrevious(searchInput.value);
        else this.search.findNext(searchInput.value);
      }
      if (e.key === 'Escape') this.toggleSearch(false);
    });
    this.searchBar = el('div', { class: 'term-search hidden' }, icon('search', 14), searchInput,
      el('button', { class: 'icon-btn', title: 'Cerrar', onclick: () => this.toggleSearch(false) }, icon('x', 14)));

    this.pane = el('div', { class: 'pane hidden' },
      el('div', { class: 'pane-body' }, this.sftpWrap, el('div', { class: 'term-col' }, this.searchBar, this.termHost)),
      el('div', { class: 'pane-footer' }, this.statusEl, this.monitorEl),
    );

    this.titleEl = el('span', { class: 'tab-title' }, this.title);
    this.broadcastBox = el('input', { type: 'checkbox', class: 'tab-bcast', title: 'Incluir en multi-ejecución', checked: true });
    this.broadcastBox.addEventListener('click', (e) => e.stopPropagation());
    this.broadcastBox.addEventListener('change', () => (this.broadcast = this.broadcastBox.checked));
    this.tabEl = el('div', { class: 'tab', draggable: 'true', title: this.describe() },
      this.broadcastBox,
      el('span', { class: 'tab-dot' }),
      icon(kindIcon(session.kind), 14),
      this.titleEl,
      el('button', { class: 'tab-close', title: 'Cerrar (Ctrl+Mayús+W)', onclick: (e: Event) => {
        e.stopPropagation();
        this.tabEl.dispatchEvent(new CustomEvent('tab-close', { bubbles: true }));
      } }, icon('x', 12)),
    );
    if (session.color) this.tabEl.style.setProperty('--tab-color', session.color);

    this.term.onData((d) => {
      if (this.recording !== null) this.recording += d;
      this.host.onInput(this, d);
    });
    this.term.onBinary((d) => this.host.onInput(this, d));
    this.term.onSelectionChange(() => {
      if (this.host.settings().copyOnSelect && this.term.hasSelection()) void navigator.clipboard.writeText(this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.keyHandler(e));
    this.termHost.addEventListener('contextmenu', (e) => {
      if (!this.host.settings().rightClickPaste) return;
      e.preventDefault();
      void this.paste();
    });
    this.ro = new ResizeObserver(() => this.doFit());
  }

  private describe(): string {
    const s = this.session;
    if (s.kind === 'local') return 'Terminal local';
    if (s.kind === 'serial') return `Serie ${s.serialPath} @ ${s.baudRate || 115200}`;
    return `${s.kind.toUpperCase()} ${s.username ? s.username + '@' : ''}${s.host}:${s.port ?? ''}`;
  }

  mount(container: HTMLElement): void {
    container.append(this.pane);
    this.term.open(this.termHost);
    this.ro.observe(this.termHost);
  }

  async connect(): Promise<void> {
    this.setState('connecting');
    this.doFit();
    try {
      await api.conn.open(this.connId, { session: this.session, cols: this.term.cols, rows: this.term.rows });
      if (this.session.kind === 'ssh') {
        if (this.session.autoSftp !== false) await this.toggleSftp(true);
        this.startMonitor();
      }
    } catch (e) {
      this.setState('error', errMsg(e));
      this.term.write(`\r\n\x1b[31m✖ ${errMsg(e)}\x1b[0m\r\n\x1b[90mPulsa R para reconectar.\x1b[0m\r\n`);
    }
  }

  async reconnect(auto = false): Promise<void> {
    window.clearTimeout(this.retryTimer);
    if (!auto) this.attempts = 0;
    if (this.disposed) return;
    await api.conn.close(this.connId);
    this.sftp?.destroy();
    this.sftp = null;
    this.sftpWrap.replaceChildren();
    this.sftpWrap.classList.add('hidden');
    this.term.write('\r\n\x1b[90m— Reconectando —\x1b[0m\r\n');
    await this.connect();
  }

  private dropped = false;
  private attempts = 0;
  private retryTimer: number | undefined;
  private disposed = false;

  private canAutoReconnect(): boolean {
    return !this.disposed && this.host.settings().autoReconnect && ['ssh', 'telnet'].includes(this.session.kind);
  }

  private scheduleReconnect(): void {
    if (!this.canAutoReconnect()) return;
    if (this.attempts >= 5) {
      this.attempts = 0;
      this.term.write('\r\n\x1b[31m— No se pudo reconectar tras 5 intentos. Pulsa R para reintentar. —\x1b[0m\r\n');
      return;
    }
    this.attempts++;
    const delay = Math.min(2 ** this.attempts, 30);
    this.term.write(`\r\n\x1b[33m— Conexión perdida. Reconectando en ${delay} s (intento ${this.attempts}/5). Pulsa R para reconectar ya. —\x1b[0m\r\n`);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.reconnect(true), delay * 1000);
  }

  setState(state: ConnState, msg?: string): void {
    const prev = this.state;
    if (state === 'connected') {
      this.attempts = 0;
      this.dropped = false;
    }
    // Un error con la sesión ya abierta es una caída de red (no un "exit" del usuario).
    if (state === 'error' && prev === 'connected') this.dropped = true;
    this.state = state;
    this.tabEl.dataset.state = state;
    const labels: Record<ConnState, string> = { connecting: 'Conectando…', connected: 'Conectado', closed: 'Desconectado', error: 'Error' };
    this.statusEl.textContent = `${labels[state]}${msg ? ' — ' + msg : ''} · ${this.describe()}`;
    if (state === 'closed' || state === 'error') this.stopMonitor();
    if (state === 'closed') {
      if (this.dropped) {
        this.dropped = false;
        this.scheduleReconnect();
      } else this.term.write('\r\n\x1b[90m— Sesión cerrada. Pulsa R para reconectar. —\x1b[0m\r\n');
    } else if (state === 'error' && this.attempts > 0 && prev === 'connecting') {
      // Falló un intento de reconexión automática: se programa el siguiente.
      this.scheduleReconnect();
    }
    this.host.onStateChange(this);
  }

  write(data: string): void {
    api.conn.write(this.connId, data);
  }

  receive(data: string): void {
    this.term.write(data);
  }

  rename(title: string): void {
    this.title = title;
    this.titleEl.textContent = title;
  }

  setBroadcastVisible(v: boolean): void {
    this.broadcastBox.style.display = v ? '' : 'none';
  }

  /** Muestra/oculta el panel. En vista dividida puede estar visible sin tener el foco. */
  display(visible: boolean, focused: boolean, cell = 0): void {
    this.pane.classList.toggle('hidden', !visible);
    this.pane.classList.toggle('focused', focused);
    this.pane.style.order = String(cell);
    this.tabEl.classList.toggle('active', focused);
    this.tabEl.classList.toggle('in-view', visible && !focused);
    if (visible) {
      requestAnimationFrame(() => {
        this.doFit();
        if (focused) this.term.focus();
      });
    }
  }

  doFit(): void {
    if (this.pane.classList.contains('hidden')) return;
    try {
      this.fit.fit();
      api.conn.resize(this.connId, this.term.cols, this.term.rows);
    } catch {
      /* terminal todavía sin dimensiones */
    }
  }

  applySettings(s: Settings): void {
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.fontSize = s.fontSize;
    this.term.options.cursorBlink = s.cursorBlink;
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.scrollback = s.scrollback;
    this.term.options.theme = themeById(s.theme).term;
    this.doFit();
  }

  async toggleSftp(force?: boolean): Promise<void> {
    if (this.session.kind !== 'ssh') return;
    const show = force ?? this.sftpWrap.classList.contains('hidden');
    this.sftpWrap.classList.toggle('hidden', !show);
    if (show && !this.sftp && this.state === 'connected') {
      this.sftp = new SftpPanel(this.connId);
      this.sftpWrap.replaceChildren(this.sftp.root, el('div', { class: 'sftp-resizer' }));
      this.enableResizer();
      await this.sftp.init();
    }
    this.doFit();
  }

  private enableResizer(): void {
    const handle = this.sftpWrap.querySelector<HTMLElement>('.sftp-resizer')!;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.sftpWrap.getBoundingClientRect().width;
      const move = (ev: MouseEvent) => {
        this.sftpWrap.style.width = `${Math.max(220, Math.min(800, startW + ev.clientX - startX))}px`;
        this.doFit();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  toggleSearch(show?: boolean): void {
    const v = show ?? this.searchBar.classList.contains('hidden');
    this.searchBar.classList.toggle('hidden', !v);
    const i = this.searchBar.querySelector('input')!;
    if (v) {
      i.focus();
      i.select();
    } else {
      this.search.clearDecorations();
      this.term.focus();
    }
    this.doFit();
  }

  async paste(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (text) this.term.paste(text);
  }

  private keyHandler(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey && e.shiftKey;
    if (mod && e.code === 'KeyC') {
      if (this.term.hasSelection()) void navigator.clipboard.writeText(this.term.getSelection());
      return false;
    }
    if (mod && e.code === 'KeyV') {
      void this.paste();
      return false;
    }
    if (mod && e.code === 'KeyF') {
      this.toggleSearch(true);
      return false;
    }
    if ((this.state === 'closed' || this.state === 'error') && e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.altKey) {
      void this.reconnect();
      return false;
    }
    // Deja pasar los atajos globales de la aplicación.
    if (mod && ['KeyT', 'KeyW', 'KeyK', 'KeyB', 'KeyM', 'KeyS', 'KeyE', 'KeyD'].includes(e.code)) return false;
    if (e.ctrlKey && e.key === 'Tab') return false;
    return true;
  }

  private startMonitor(): void {
    this.stopMonitor();
    const tick = async () => {
      if (this.pane.classList.contains('hidden') || this.state !== 'connected') return;
      try {
        const s = await api.monitor.stats(this.connId);
        const parts: string[] = [];
        if (s.load !== null) parts.push(`CPU ${s.load.toFixed(2)}${s.cpus ? '/' + s.cpus : ''}`);
        if (s.memTotal) parts.push(`RAM ${Math.round((s.memUsed / s.memTotal) * 100)}% de ${(s.memTotal / 1024).toFixed(1)} GB`);
        if (s.disk) parts.push(`Disco / ${s.disk}`);
        if (s.uptimeSec) parts.push(`Activo ${formatUptime(s.uptimeSec)}`);
        this.monitorEl.textContent = parts.join('  ·  ');
      } catch {
        this.monitorEl.textContent = '';
      }
    };
    void tick();
    this.monitorTimer = window.setInterval(tick, 5000);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) window.clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    this.stopMonitor();
    this.ro.disconnect();
    this.sftp?.destroy();
    void api.conn.close(this.connId);
    this.term.dispose();
    this.pane.remove();
    this.tabEl.remove();
  }
}

export function kindIcon(kind: SessionConfig['kind']) {
  return ({ ssh: 'server', local: 'terminal', telnet: 'link', serial: 'serial', rdp: 'monitor', vnc: 'monitor' } as const)[kind];
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
