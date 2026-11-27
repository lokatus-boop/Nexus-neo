// «Acerca de» y aceptación del aviso legal en el primer arranque.
import { api } from './api';
import { el, checkbox, modal } from './ui';
import { AUTHOR, DISCLAIMER, DISCLAIMER_TITLE, DISCLAIMER_VERSION, REPO_URL } from '../shared/legal';
import type { Settings } from '../shared/types';

export interface AboutInfo {
  version: string;
  platform: string;
  versions?: { electron: string; chrome: string; node: string };
}

function disclaimerBlock(): HTMLElement {
  return el('div', { class: 'disclaimer' }, ...DISCLAIMER.map((p) => el('p', {}, p)));
}

export function logo(size: number): HTMLElement {
  return el('img', { class: 'app-logo', src: 'logo.svg', width: size, height: size, alt: '', draggable: 'false' });
}

export async function aboutDialog(info: AboutInfo): Promise<void> {
  const v = info.versions;
  const body = el('div', { class: 'about' },
    el('div', { class: 'about-head' },
      logo(84),
      el('div', {},
        el('h1', {}, 'Nexus Neo'),
        el('p', { class: 'about-version' }, `Versión ${info.version}`),
        el('p', { class: 'about-author' }, 'Hecho por ', el('strong', {}, AUTHOR)),
      ),
    ),
    el('p', {}, 'Cliente de acceso remoto multiplataforma: SSH, SFTP, Telnet, serie, túneles, X11, VNC, servidores integrados, multi-ejecución y macros.'),
    el('p', { class: 'about-meta' },
      `© ${new Date().getFullYear()} ${AUTHOR} · Licencia MIT · `,
      el('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Repositorio en GitHub'),
    ),
    v ? el('p', { class: 'about-meta' }, `Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node} · ${info.platform}`) : null,
    el('h3', {}, DISCLAIMER_TITLE),
    disclaimerBlock(),
  );
  await modal<boolean>('Acerca de Nexus Neo', body, [{ label: 'Cerrar', value: true, kind: 'primary' }], { dismiss: false, wide: true });
}

/** Muestra el aviso legal hasta que el usuario lo acepte. Devuelve false si decide salir. */
export async function ensureDisclaimerAccepted(settings: Settings): Promise<boolean> {
  if ((settings.disclaimerAccepted || 0) >= DISCLAIMER_VERSION) return true;
  const agree = checkbox('He leído el aviso y acepto usar Nexus Neo bajo mi propia responsabilidad.');
  const accept = el('button', { class: 'btn primary', disabled: true }, 'Aceptar y continuar');
  agree.box.addEventListener('change', () => (accept.disabled = !agree.box.checked));
  const body = el('div', { class: 'about first-run' },
    el('div', { class: 'about-head' },
      logo(64),
      el('div', {}, el('h1', {}, 'Bienvenido a Nexus Neo'), el('p', { class: 'about-author' }, 'Hecho por ', el('strong', {}, AUTHOR))),
    ),
    el('p', {}, 'Antes de empezar, lee y acepta las condiciones de uso:'),
    disclaimerBlock(),
    agree.wrap,
  );
  const ok = await modal<boolean>(DISCLAIMER_TITLE, body, [{ label: 'Salir', value: false, kind: 'ghost' }], {
    wide: true,
    bind: (close) => {
      accept.addEventListener('click', () => close(true));
      queueMicrotask(() => body.closest('.modal')?.querySelector('.modal-footer')?.append(accept));
    },
  });
  if (!ok) {
    await api.quit();
    return false;
  }
  Object.assign(settings, await api.settings.save({ disclaimerAccepted: DISCLAIMER_VERSION }));
  return true;
}
