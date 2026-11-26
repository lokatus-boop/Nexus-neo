// Utilidades de interfaz: creación de elementos, diálogos modales, menús y avisos.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function icon(name: keyof typeof ICONS, size = 16): HTMLElement {
  const span = el('span', { class: 'icon' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 8h.01M7 17h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  record: '<circle cx="12" cy="12" r="6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  tunnel: '<path d="M3 20V10a9 9 0 0 1 18 0v10"/><path d="M7 20v-8a5 5 0 0 1 10 0v8"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12m-5-5 5 5 5-5M4 20h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  home: '<path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  newFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  serial: '<path d="M7 4v6M17 4v6M5 10h14v3a7 7 0 0 1-14 0zM12 20v-3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  import: '<path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  export: '<path d="M12 15V3m-4 4 4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
} as const;

// ---------------------------------------------------------------------------
// Avisos

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 4000): void {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div', { id: 'toasts' });
    document.body.append(box);
  }
  const t = el('div', { class: `toast toast-${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Limpia el prefijo que añade Electron a los errores de IPC.
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------------------
// Diálogos modales

export interface ModalButton<T> {
  label: string;
  value: T | (() => T | Promise<T> | undefined);
  kind?: 'primary' | 'danger' | 'ghost';
}

export function modal<T>(title: string, body: Node, buttons: ModalButton<T>[], opts: { wide?: boolean; dismiss?: T; bind?: (close: (v: T) => void) => void } = {}): Promise<T> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const footer = el('div', { class: 'modal-footer' });
    const box = el('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-header' }, el('h2', {}, title)),
      el('div', { class: 'modal-body' }, body),
      footer,
    );
    const close = (v: T) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus();
      resolve(v);
    };
    const run = async (b: ModalButton<T>) => {
      if (typeof b.value === 'function') {
        try {
          const r = await (b.value as () => T | Promise<T> | undefined)();
          if (r !== undefined) close(r);
        } catch (e) {
          toast(errMsg(e), 'error');
        }
      } else close(b.value);
    };
    for (const b of buttons) footer.append(el('button', { class: `btn ${b.kind || ''}`, onclick: () => void run(b) }, b.label));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && opts.dismiss !== undefined) {
        e.stopPropagation();
        close(opts.dismiss);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = buttons.find((b) => b.kind === 'primary');
        if (primary) {
          e.preventDefault();
          void run(primary);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    opts.bind?.(close);
    backdrop.append(box);
    document.body.append(backdrop);
    const first = box.querySelector<HTMLElement>('input:not([type=checkbox]),select,textarea');
    (first || footer.querySelector<HTMLElement>('.primary'))?.focus();
  });
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('small', { class: 'hint' }, hint) : null);
}

export function input(attrs: Attrs = {}): HTMLInputElement {
  return el('input', { type: 'text', spellcheck: 'false', ...attrs });
}

export function select(options: [string, string][], value?: string): HTMLSelectElement {
  const s = el('select');
  for (const [v, l] of options) s.append(el('option', { value: v, selected: v === value }, l));
  return s;
}

export function checkbox(label: string, checked = false): { wrap: HTMLElement; box: HTMLInputElement } {
  const box = el('input', { type: 'checkbox', checked });
  return { wrap: el('label', { class: 'check' }, box, el('span', {}, label)), box };
}

export async function confirmDialog(title: string, message: string, ok = 'Aceptar', danger = false): Promise<boolean> {
  return modal(title, el('p', {}, message), [
    { label: 'Cancelar', value: false, kind: 'ghost' },
    { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
  ], { dismiss: false });
}

export async function promptDialog(title: string, label: string, value = '', password = false): Promise<string | null> {
  const i = input({ value, type: password ? 'password' : 'text' });
  return modal<string | null>(title, field(label, i), [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    { label: 'Aceptar', value: () => i.value, kind: 'primary' },
  ], { dismiss: null });
}

// ---------------------------------------------------------------------------
// Menú contextual

export interface MenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (it.separator) {
      menu.append(el('div', { class: 'ctx-sep' }));
      continue;
    }
    menu.append(
      el('button', {
        class: `ctx-item${it.danger ? ' danger' : ''}`,
        disabled: it.disabled,
        onclick: () => {
          menu.remove();
          it.action?.();
        },
      }, it.label),
    );
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  const off = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', off, true));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
