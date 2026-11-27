// Visor RDP integrado: cliente IronRDP (WebAssembly) dentro de una ventana de Nexus Neo.
// La conexión de red la hace la pasarela RDCleanPath del proceso principal (TCP, TLS y, si se
// configura, el túnel SSH); aquí sólo hay un WebSocket a 127.0.0.1 con un vale de un solo uso.
import './rdp.css';
import '@devolutions/iron-remote-desktop';
import { Backend, init, displayControl, clientName } from '@devolutions/iron-remote-desktop-rdp';
import type { UserInteraction, IronError } from '@devolutions/iron-remote-desktop';
import { api } from './api';

const id = new URLSearchParams(location.search).get('id') || '';

interface RdpInfo {
  name: string;
  target: string;
  destination: string;
  url: string;
  token: string;
  username: string;
  domain: string;
  password: string | null;
  canSave: boolean;
  width: number;
  height: number;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const errText = (e: unknown) => {
  const m = e && typeof e === 'object' && 'backtrace' in e ? (e as IronError).backtrace() : e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

const status = h('span', { id: 'status' }, 'Preparando…');
const title = h('span', { class: 'title' }, 'RDP');
const target = h('span', { class: 'target' });
const screen = h('div', { id: 'screen' });
const overlay = h('div', { id: 'overlay', class: 'hidden' });
let ui: UserInteraction | null = null;
let connected = false;
let fit = true;
let dynamic = true;

const btn = (label: string, fn: () => void, tip = '') => {
  const b = h('button', { title: tip }, label);
  b.addEventListener('click', fn);
  return b;
};
const fitBtn = btn('Ajustar', () => {
  fit = !fit;
  ui?.setScale(fit ? 1 : 3);
  fitBtn.classList.toggle('active', fit);
}, 'Escalar el escritorio remoto a la ventana o verlo a tamaño real');
const dynBtn = btn('Resolución dinámica', () => {
  dynamic = !dynamic;
  dynBtn.classList.toggle('active', dynamic);
  if (dynamic) resizeRemote();
}, 'Cambiar la resolución remota al redimensionar la ventana');
const reconnectBtn = btn('Reconectar', () => void start(), 'Volver a conectar');
reconnectBtn.disabled = true;

document.body.append(
  h('div', { id: 'bar' }, title, target, h('span', { class: 'spacer' }), status,
    fitBtn, dynBtn,
    btn('Ctrl+Alt+Supr', () => ui?.ctrlAltDel()),
    btn('Tecla Windows', () => ui?.metaKey()),
    btn('Pantalla completa', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())),
    reconnectBtn,
    btn('Desconectar', () => ui?.shutdown())),
  screen,
  overlay,
);
fitBtn.classList.add('active');
dynBtn.classList.add('active');

function setStatus(text: string, cls = ''): void {
  status.textContent = text;
  status.className = cls;
}

function showOverlay(box: HTMLElement, focus?: HTMLElement): void {
  overlay.replaceChildren(box);
  overlay.classList.remove('hidden');
  (focus || box.querySelector<HTMLElement>('input,button'))?.focus();
}

function hideOverlay(): void {
  overlay.classList.add('hidden');
  overlay.replaceChildren();
}

// Huella del certificado TLS del servidor (primera conexión o cambio de certificado).
api.rdp.onCert((reqId: string, p: { host: string; port: number; fingerprint: string; subject: string; issuer: string; previous?: string }) => {
  const changed = !!p.previous;
  const done = (ok: boolean) => {
    hideOverlay();
    api.prompts.reply(reqId, ok);
  };
  const ok = btn(changed ? 'Aceptar el nuevo certificado' : 'Confiar y conectar', () => done(true));
  ok.className = changed ? 'danger' : 'primary';
  showOverlay(h('div', { class: 'box', id: 'cert-box' },
    h('strong', {}, changed ? 'El certificado del servidor ha cambiado' : 'Verificar el servidor RDP'),
    changed
      ? h('p', { class: 'danger-text' }, `⚠ El certificado de ${p.host}:${p.port} no es el que se guardó. Podría ser un ataque de intermediario. Huella anterior: ${p.previous}`)
      : h('p', {}, `Es la primera vez que te conectas a ${p.host}:${p.port}. Comprueba la huella del certificado.`),
    h('pre', {}, `${p.subject ? `CN=${p.subject}\n` : ''}${p.issuer && p.issuer !== p.subject ? `Emisor: ${p.issuer}\n` : ''}${p.fingerprint}`),
    h('div', { class: 'row' }, btn('Cancelar', () => done(false)), ok)), ok);
});

function askCredentials(info: RdpInfo, message?: string): Promise<{ username: string; domain: string; password: string; save: boolean } | null> {
  return new Promise((resolve) => {
    const user = h('input', { type: 'text', value: info.username, placeholder: 'Administrador', spellcheck: 'false' }) as HTMLInputElement;
    const domain = h('input', { type: 'text', value: info.domain, placeholder: 'Opcional', spellcheck: 'false' }) as HTMLInputElement;
    const pass = h('input', { type: 'password', placeholder: 'Contraseña de Windows' }) as HTMLInputElement;
    const save = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const done = (ok: boolean) => {
      hideOverlay();
      resolve(ok ? { username: user.value.trim(), domain: domain.value.trim(), password: pass.value, save: save.checked } : null);
    };
    for (const i of [user, domain, pass]) {
      i.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
    }
    showOverlay(h('div', { class: 'box', id: 'login-box' },
      h('strong', {}, `Iniciar sesión en ${info.name}`),
      message ? h('p', { class: 'danger-text' }, message) : h('p', {}, info.target),
      h('label', {}, 'Usuario', user),
      h('label', {}, 'Dominio', domain),
      h('label', {}, 'Contraseña', pass),
      info.canSave ? h('label', { class: 'check' }, save, 'Guardar la contraseña en la bóveda') : '',
      h('div', { class: 'row' }, btn('Cancelar', () => done(false)), Object.assign(btn('Conectar', () => done(true)), { className: 'primary' }))),
    info.username ? pass : user);
  });
}

function remoteSize(info?: RdpInfo): { width: number; height: number } {
  if (info?.width && info.height) return { width: info.width, height: info.height };
  return { width: Math.max(640, Math.floor(screen.clientWidth / 2) * 2), height: Math.max(480, Math.floor(screen.clientHeight / 2) * 2) };
}

let resizeTimer: number | undefined;
function resizeRemote(): void {
  if (!connected || !dynamic || !ui) return;
  const { width, height } = remoteSize();
  ui.resize(width, height);
}
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resizeRemote, 400);
});
for (const ev of ['keydown', 'mousedown', 'wheel']) window.addEventListener(ev, () => api.rdp.activity(), { passive: true });

let wasmReady: Promise<void> | null = null;

function mountElement(): Promise<UserInteraction> {
  return new Promise((resolve) => {
    const elx = document.createElement('iron-remote-desktop') as HTMLElement & { module?: unknown };
    elx.setAttribute('scale', 'fit');
    elx.setAttribute('flexcenter', 'true');
    elx.setAttribute('verbose', 'false');
    elx.module = Backend;
    elx.addEventListener('ready', (e) => resolve((e as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail.irgUserInteraction));
    screen.replaceChildren(elx);
  });
}

async function start(message?: string): Promise<void> {
  reconnectBtn.disabled = true;
  connected = false;
  setStatus('Preparando…');
  let info: RdpInfo;
  try {
    info = await api.rdp.prepare(id);
  } catch (e) {
    setStatus(`Error: ${errText(e)}`, 'err');
    return;
  }
  title.textContent = info.name;
  target.textContent = info.target;
  document.title = `${info.name} — RDP · Nexus Neo`;
  if (info.width && info.height) {
    dynamic = false;
    dynBtn.classList.remove('active');
  }

  let { username, domain } = info;
  let password = info.password;
  if (!password || !username || message) {
    const c = await askCredentials(info, message);
    if (!c) {
      setStatus('Cancelado');
      reconnectBtn.disabled = false;
      return;
    }
    ({ username, domain, password } = c);
    if (c.save) void api.rdp.savePassword(id, c.password);
  }

  setStatus('Conectando…');
  try {
    wasmReady ??= init('WARN');
    await wasmReady;
    ui = await mountElement();
    ui.setEnableClipboard(true);
    const config = ui.configBuilder()
      .withUsername(username)
      .withPassword(password || '')
      .withServerDomain(domain)
      .withDestination(info.destination)
      .withProxyAddress(info.url)
      .withAuthToken(info.token)
      .withDesktopSize(remoteSize(info))
      .withExtension(displayControl(true))
      .withExtension(clientName('Nexus Neo'))
      .build();
    const session = await ui.connect(config);
    connected = true;
    ui.setVisibility(true);
    ui.setScale(fit ? 1 : 3);
    setStatus('Conectado', 'ok');
    const end = await session.run();
    connected = false;
    setStatus(`Desconectado${end.reason() ? ` — ${end.reason()}` : ''}`);
  } catch (e) {
    connected = false;
    const kind = e && typeof e === 'object' && 'kind' in e ? (e as IronError).kind() : -1;
    // 1 = contraseña incorrecta, 2 = inicio de sesión fallido.
    if (kind === 1 || kind === 2) return start('Usuario o contraseña incorrectos.');
    setStatus(`Error: ${errText(e).split('\n')[0]}`, 'err');
  }
  reconnectBtn.disabled = false;
}

void start();
