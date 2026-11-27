// Diálogo de creación/edición de sesiones.
import { api, uid } from './api';
import { el, field, input, select, checkbox, modal, icon, toast } from './ui';
import { DEFAULT_PORTS } from './quick-connect';
import type { Macro, SessionConfig, SessionKind, TunnelConfig, VaultStatus } from '../shared/types';

const KIND_LABEL: Record<SessionKind, string> = { ssh: 'SSH', local: 'Terminal local', telnet: 'Telnet', serial: 'Serie', rdp: 'RDP', vnc: 'VNC' };

export interface EditorContext {
  sessions: SessionConfig[];
  macros: Macro[];
  shells: { id: string; name: string }[];
  vault: VaultStatus;
}

export async function editSession(initial: Partial<SessionConfig>, ctx: EditorContext): Promise<SessionConfig | null> {
  const s: SessionConfig = {
    id: '',
    name: '',
    folder: '',
    kind: 'ssh',
    port: 22,
    auth: 'password',
    tunnels: [],
    autoSftp: true,
    ...initial,
  } as SessionConfig;

  // --- Campos comunes ---
  const kind = select(Object.entries(KIND_LABEL) as [string, string][], s.kind);
  const name = input({ value: s.name, placeholder: 'Mi servidor' });
  const folders = [...new Set(ctx.sessions.map((x) => x.folder).filter(Boolean))];
  const folder = input({ value: s.folder, placeholder: 'Producción/Web', list: 'folder-list' });
  const folderList = el('datalist', { id: 'folder-list' }, ...folders.map((f) => el('option', { value: f })));
  const color = el('input', { type: 'color', value: s.color || '#2dd4bf' });
  const useColor = checkbox('Color de pestaña', !!s.color);
  const notes = el('textarea', { rows: '2', placeholder: 'Notas (opcional)' }) as HTMLTextAreaElement;
  notes.value = s.notes || '';

  // --- Red ---
  const host = input({ value: s.host || '', placeholder: 'servidor.ejemplo.com' });
  const port = input({ type: 'number', value: String(s.port ?? 22), min: '1', max: '65535' });
  const username = input({ value: s.username || '', placeholder: 'usuario' });

  // --- SSH ---
  const auth = select([['password', 'Contraseña'], ['key', 'Clave privada'], ['agent', 'Agente SSH']], s.auth || 'password');
  const keyPath = input({ value: s.keyPath || '', placeholder: 'Vacío = ~/.ssh/id_ed25519, id_rsa…' });
  const keyBtn = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
    const p = await api.pickFile('Selecciona la clave privada');
    if (p) keyPath.value = p;
  } }, 'Examinar…');
  const password = input({ type: 'password', placeholder: ctx.vault.unlocked ? 'Se guarda cifrada en la bóveda' : 'Desbloquea la bóveda para guardarla' });
  const passphrase = input({ type: 'password', placeholder: 'Frase de paso de la clave (opcional)' });
  if (!ctx.vault.unlocked) {
    password.disabled = true;
    passphrase.disabled = true;
  }
  const hasSecret = s.id ? await api.sessions.hasSecret(s.id) : false;
  const clearSecret = checkbox('Borrar la credencial guardada', false);
  const jump = select([['', '— Ninguno —'], ...ctx.sessions.filter((x) => x.kind === 'ssh' && x.id !== s.id).map((x) => [x.id, `${x.name} (${x.host})`] as [string, string])], s.jumpSessionId || '');
  const x11 = checkbox('Reenvío X11 (requiere un servidor X local)', !!s.x11);
  const autoSftp = checkbox('Abrir el explorador SFTP al conectar', s.autoSftp !== false);
  const keepAlive = input({ type: 'number', value: String(s.keepAliveSec ?? 30), min: '0' });
  const term = input({ value: s.term || 'xterm-256color' });
  const macro = select([['', '— Ninguna —'], ...ctx.macros.map((m) => [m.id, m.name] as [string, string])], s.startupMacroId || '');

  // --- Túneles ---
  const tunnels: TunnelConfig[] = (s.tunnels || []).map((t) => ({ ...t }));
  const tunnelList = el('div', { class: 'tunnel-list' });
  const renderTunnels = () => {
    tunnelList.replaceChildren(
      ...tunnels.map((t, i) => {
        const type = select([['local', 'Local (-L)'], ['remote', 'Remoto (-R)'], ['dynamic', 'Dinámico SOCKS (-D)']], t.type);
        const bh = input({ value: t.bindHost, class: 'sm' });
        const bp = input({ type: 'number', value: String(t.bindPort || ''), class: 'xs' });
        const dh = input({ value: t.destHost, class: 'sm', placeholder: 'destino' });
        const dp = input({ type: 'number', value: String(t.destPort || ''), class: 'xs' });
        const auto = checkbox('Auto', t.autoStart);
        const sync = () => {
          t.type = type.value as TunnelConfig['type'];
          t.bindHost = bh.value || '127.0.0.1';
          t.bindPort = Number(bp.value);
          t.destHost = dh.value;
          t.destPort = Number(dp.value);
          t.autoStart = auto.box.checked;
          dh.style.visibility = dp.style.visibility = t.type === 'dynamic' ? 'hidden' : '';
        };
        for (const x of [type, bh, bp, dh, dp, auto.box]) x.addEventListener('input', sync);
        sync();
        return el('div', { class: 'tunnel-row' }, type, bh, el('span', {}, ':'), bp, el('span', {}, '→'), dh, el('span', {}, ':'), dp, auto.wrap,
          el('button', { class: 'icon-btn', type: 'button', title: 'Quitar', onclick: () => {
            tunnels.splice(i, 1);
            renderTunnels();
          } }, icon('trash', 14)));
      }),
    );
  };
  renderTunnels();
  const addTunnel = el('button', { class: 'btn ghost', type: 'button', onclick: () => {
    tunnels.push({ id: uid(), name: '', type: 'local', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80, autoStart: true });
    renderTunnels();
  } }, icon('plus', 14), ' Añadir túnel');

  // --- Local ---
  const shellSel = select([['', 'Predeterminado'], ...ctx.shells.map((x) => [x.id, x.name] as [string, string])], s.shell || '');
  const cwd = input({ value: s.cwd || '', placeholder: 'Carpeta inicial (opcional)' });

  // --- Serie ---
  const serialPath = input({ value: s.serialPath || '', placeholder: navigator.userAgent.includes('Windows') ? 'COM3' : '/dev/ttyUSB0', list: 'serial-list' });
  const serialList = el('datalist', { id: 'serial-list' });
  void api.serial.list().then((ports: { path: string; label: string }[]) => {
    for (const p of ports) serialList.append(el('option', { value: p.path }, p.label));
  });
  const baud = select(['300', '1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map((b) => [b, b] as [string, string]), String(s.baudRate || 115200));
  const dataBits = select([['8', '8'], ['7', '7'], ['6', '6'], ['5', '5']], String(s.dataBits || 8));
  const stopBits = select([['1', '1'], ['2', '2']], String(s.stopBits || 1));
  const parity = select([['none', 'Ninguna'], ['even', 'Par'], ['odd', 'Impar'], ['mark', 'Marca'], ['space', 'Espacio']], s.parity || 'none');
  const localEcho = checkbox('Eco local', !!s.localEcho);

  // --- RDP ---
  const rdpFull = checkbox('Pantalla completa', !!s.rdpFullscreen);
  const rdpRes = input({ value: s.rdpResolution || '', placeholder: '1920x1080' });

  const sections = {
    net: el('fieldset', {}, el('legend', {}, 'Conexión'), el('div', { class: 'grid3' }, field('Host', host), field('Puerto', port), field('Usuario', username))),
    ssh: el('fieldset', {}, el('legend', {}, 'Autenticación SSH'),
      el('div', { class: 'grid2' }, field('Método', auth), field('Saltar a través de (bastión)', jump)),
      el('div', { class: 'row' }, field('Clave privada', keyPath), keyBtn),
      el('div', { class: 'grid2' }, field('Contraseña', password, hasSecret ? 'Hay una credencial guardada. Déjalo vacío para mantenerla.' : undefined), field('Frase de paso', passphrase)),
      hasSecret ? clearSecret.wrap : null,
    ),
    sshOpts: el('fieldset', {}, el('legend', {}, 'Opciones avanzadas'),
      el('div', { class: 'grid3' }, field('Keepalive (s)', keepAlive), field('TERM', term), field('Macro al conectar', macro)),
      x11.wrap, autoSftp.wrap,
    ),
    tunnels: el('fieldset', {}, el('legend', {}, 'Túneles SSH'), tunnelList, addTunnel),
    local: el('fieldset', {}, el('legend', {}, 'Terminal local'), el('div', { class: 'grid2' }, field('Shell', shellSel), field('Directorio', cwd))),
    serial: el('fieldset', {}, el('legend', {}, 'Puerto serie'),
      el('div', { class: 'grid3' }, field('Puerto', serialPath), field('Baudios', baud), field('Bits de datos', dataBits)),
      el('div', { class: 'grid3' }, field('Bits de parada', stopBits), field('Paridad', parity), el('div', {}, localEcho.wrap)), serialList),
    rdp: el('fieldset', {}, el('legend', {}, 'Escritorio remoto'), el('div', { class: 'grid2' }, field('Resolución', rdpRes), el('div', {}, rdpFull.wrap)),
      el('small', { class: 'hint' }, 'En esta versión RDP y VNC se abren con el cliente del sistema (mstsc, xfreerdp, vncviewer). El visor integrado está en la hoja de ruta.')),
  };

  const update = () => {
    const k = kind.value as SessionKind;
    sections.net.style.display = ['ssh', 'telnet', 'rdp', 'vnc'].includes(k) ? '' : 'none';
    sections.ssh.style.display = sections.sshOpts.style.display = sections.tunnels.style.display = k === 'ssh' ? '' : 'none';
    sections.local.style.display = k === 'local' ? '' : 'none';
    sections.serial.style.display = k === 'serial' ? '' : 'none';
    sections.rdp.style.display = k === 'rdp' || k === 'vnc' ? '' : 'none';
    username.parentElement!.style.display = k === 'vnc' ? 'none' : '';
    keyPath.parentElement!.parentElement!.style.display = auth.value === 'key' ? '' : 'none';
  };
  kind.addEventListener('change', () => {
    const k = kind.value as SessionKind;
    if (DEFAULT_PORTS[k]) port.value = String(DEFAULT_PORTS[k]);
    update();
  });
  auth.addEventListener('change', update);

  const body = el('div', { class: 'session-form' },
    el('div', { class: 'grid3' }, field('Tipo', kind), field('Nombre', name), field('Carpeta', folder)), folderList,
    sections.net, sections.ssh, sections.sshOpts, sections.tunnels, sections.local, sections.serial, sections.rdp,
    el('div', { class: 'row' }, useColor.wrap, color),
    field('Notas', notes),
  );
  update();

  return modal<SessionConfig | null>(s.id ? `Editar sesión — ${s.name}` : 'Nueva sesión', body, [
    { label: 'Cancelar', value: null, kind: 'ghost' },
    {
      label: 'Guardar',
      kind: 'primary',
      value: async () => {
        const k = kind.value as SessionKind;
        const needsHost = ['ssh', 'telnet', 'rdp', 'vnc'].includes(k);
        if (needsHost && !host.value.trim()) throw new Error('Indica el host.');
        if (k === 'serial' && !serialPath.value.trim()) throw new Error('Indica el puerto serie.');
        for (const t of tunnels) {
          if (!t.bindPort || (t.type !== 'dynamic' && (!t.destHost || !t.destPort))) throw new Error('Completa los datos de todos los túneles.');
        }
        const out: SessionConfig = {
          id: s.id,
          name: name.value.trim() || (needsHost ? host.value.trim() : KIND_LABEL[k]),
          folder: folder.value.trim().replace(/^\/+|\/+$/g, ''),
          kind: k,
          color: useColor.box.checked ? color.value : undefined,
          notes: notes.value || undefined,
        };
        if (needsHost) {
          out.host = host.value.trim();
          out.port = Number(port.value) || DEFAULT_PORTS[k];
          if (k !== 'vnc') out.username = username.value.trim() || undefined;
        }
        if (k === 'ssh') {
          Object.assign(out, {
            auth: auth.value,
            keyPath: auth.value === 'key' ? keyPath.value.trim() || undefined : undefined,
            jumpSessionId: jump.value || undefined,
            x11: x11.box.checked,
            autoSftp: autoSftp.box.checked,
            keepAliveSec: Number(keepAlive.value) || 0,
            term: term.value.trim() || 'xterm-256color',
            startupMacroId: macro.value || undefined,
            tunnels,
          });
        }
        if (k === 'local') Object.assign(out, { shell: shellSel.value || undefined, cwd: cwd.value.trim() || undefined });
        if (k === 'serial') {
          Object.assign(out, {
            serialPath: serialPath.value.trim(),
            baudRate: Number(baud.value),
            dataBits: Number(dataBits.value),
            stopBits: Number(stopBits.value),
            parity: parity.value,
            localEcho: localEcho.box.checked,
          });
        }
        if (k === 'rdp') Object.assign(out, { rdpFullscreen: rdpFull.box.checked, rdpResolution: rdpRes.value.trim() || undefined });

        const secret = password.value || passphrase.value ? { password: password.value || undefined, passphrase: passphrase.value || undefined } : null;
        const saved = (await api.sessions.save(out, secret)) as SessionConfig;
        if (clearSecret.box.checked) await api.sessions.clearSecret(saved.id);
        if (secret) toast('Credencial guardada en la bóveda', 'ok');
        return saved;
      },
    },
  ], { wide: true, dismiss: null });
}
