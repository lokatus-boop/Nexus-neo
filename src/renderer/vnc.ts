// Visor VNC integrado basado en noVNC. La conexión TCP la hace el proceso principal
// y llega aquí por IPC mediante un canal compatible con WebSocket.
import './vnc.css';
import RFB from '@novnc/novnc/lib/rfb.js';
import { initLogging } from '@novnc/novnc/lib/util/logging.js';
import { api } from './api';

const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
if (params.get('debug')) initLogging('debug');

/** Canal con la interfaz mínima que noVNC espera de un WebSocket/RTCDataChannel. */
class IpcChannel {
  binaryType = 'arraybuffer';
  protocol = '';
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') return;
    api.vnc.write(id, data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    void api.vnc.disconnect(id);
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }

  _open(): void {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }

  _data(chunk: Uint8Array): void {
    const copy = chunk.slice();
    this.onmessage?.({ data: copy.buffer });
  }

  _closed(reason?: string): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.({ code: reason ? 1006 : 1000, reason: reason || '', wasClean: !reason });
  }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const status = h('span', { id: 'status' }, 'Conectando…');
const title = h('span', { class: 'title' }, 'VNC');
const target = h('span', { class: 'target' });
const btn = (label: string, fn: () => void, tip = '') => {
  const b = h('button', { title: tip }, label);
  b.addEventListener('click', fn);
  return b;
};
const screen = h('div', { id: 'screen' });
const overlay = h('div', { id: 'overlay', class: 'hidden' });
let rfb: RFB | null = null;

const scaleBtn = btn('Ajustar', () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  scaleBtn.classList.toggle('active', rfb.scaleViewport);
}, 'Escalar la pantalla remota a la ventana');
const viewBtn = btn('Sólo ver', () => {
  if (!rfb) return;
  rfb.viewOnly = !rfb.viewOnly;
  viewBtn.classList.toggle('active', rfb.viewOnly);
}, 'No enviar teclado ni ratón');

document.body.append(
  h('div', { id: 'bar' }, title, target, h('span', { class: 'spacer' }), status,
    scaleBtn, viewBtn,
    btn('Ctrl+Alt+Supr', () => rfb?.sendCtrlAltDel()),
    btn('Pegar portapapeles', async () => {
      const t = await navigator.clipboard.readText();
      if (t) rfb?.clipboardPasteFrom(t);
    }, 'Envía el texto del portapapeles local al remoto'),
    btn('Pantalla completa', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())),
    btn('Desconectar', () => rfb?.disconnect())),
  screen,
  overlay,
);

function setStatus(text: string, cls = ''): void {
  status.textContent = text;
  status.className = cls;
}

function askPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', placeholder: 'Contraseña VNC' }) as HTMLInputElement;
    const ok = h('button', { class: 'primary' }, 'Conectar');
    const done = (v: string | null) => {
      overlay.classList.add('hidden');
      overlay.replaceChildren();
      resolve(v);
    };
    ok.addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    overlay.replaceChildren(h('div', { class: 'box' }, h('strong', {}, 'El servidor pide contraseña'), input, ok));
    overlay.classList.remove('hidden');
    input.focus();
  });
}

async function start(): Promise<void> {
  const channel = new IpcChannel();
  api.vnc.onData((chunk: Uint8Array) => channel._data(chunk));
  api.vnc.onClosed((reason?: string) => channel._closed(reason));
  let info: { name: string; target: string };
  try {
    info = await api.vnc.connect(id);
  } catch (e) {
    setStatus(`Error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'err');
    return;
  }
  title.textContent = info.name;
  target.textContent = info.target;
  document.title = `${info.name} — VNC · Nexus Neo`;
  rfb = new RFB(screen, channel, { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  scaleBtn.classList.add('active');
  rfb.addEventListener('connect', () => {
    setStatus('Conectado', 'ok');
    rfb?.focus();
  });
  rfb.addEventListener('disconnect', (e: Event) => {
    const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
    setStatus(clean ? 'Desconectado' : 'Conexión perdida', clean ? '' : 'err');
  });
  rfb.addEventListener('securityfailure', (e: Event) => {
    setStatus(`Autenticación fallida: ${(e as CustomEvent<{ reason?: string }>).detail?.reason || ''}`, 'err');
  });
  rfb.addEventListener('credentialsrequired', async () => {
    const saved = await api.vnc.secret(id);
    const pw = saved ?? (await askPassword());
    if (pw === null) return rfb?.disconnect();
    rfb?.sendCredentials({ password: pw });
  });
  rfb.addEventListener('desktopname', (e: Event) => {
    const name = (e as CustomEvent<{ name: string }>).detail?.name;
    if (name) target.textContent = `${info.target} · ${name}`;
  });
  channel._open();
}

void start();
