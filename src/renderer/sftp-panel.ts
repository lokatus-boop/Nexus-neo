// Panel SFTP que acompaña a una pestaña SSH.
import { api } from './api';
import { el, icon, toast, errMsg, contextMenu, promptDialog, confirmDialog, modal, formatBytes } from './ui';
import type { SftpEntry } from '../shared/types';

export class SftpPanel {
  readonly root: HTMLElement;
  private pathInput: HTMLInputElement;
  private listEl: HTMLElement;
  private progressEl: HTMLElement;
  private cwd = '/';
  private entries: SftpEntry[] = [];
  private selected = new Set<string>();
  private showHidden = false;
  private offProgress: () => void;

  constructor(private readonly connId: string) {
    this.pathInput = el('input', { class: 'sftp-path', spellcheck: 'false' });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.go(this.pathInput.value.trim() || '/');
    });
    const btn = (name: Parameters<typeof icon>[0], title: string, fn: () => void) =>
      el('button', { class: 'icon-btn', title, onclick: fn }, icon(name));
    const hiddenBtn = el('button', { class: 'icon-btn text', title: 'Mostrar ocultos', onclick: () => {
      this.showHidden = !this.showHidden;
      hiddenBtn.classList.toggle('active', this.showHidden);
      this.render();
    } }, '.*');
    this.listEl = el('div', { class: 'sftp-list', tabindex: '0' });
    this.progressEl = el('div', { class: 'sftp-progress hidden' });
    this.root = el('div', { class: 'sftp-panel' },
      el('div', { class: 'sftp-toolbar' },
        btn('up', 'Subir un nivel', () => void this.go(parentOf(this.cwd))),
        btn('home', 'Carpeta personal', () => void this.goHome()),
        btn('refresh', 'Actualizar', () => void this.refresh()),
        btn('upload', 'Subir archivos', () => void this.upload()),
        btn('download', 'Descargar selección', () => void this.download()),
        btn('newFolder', 'Nueva carpeta', () => void this.mkdir()),
        hiddenBtn,
      ),
      this.pathInput,
      this.listEl,
      this.progressEl,
    );

    // Arrastrar y soltar desde el explorador del sistema para subir.
    this.listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.listEl.classList.add('drop');
    });
    this.listEl.addEventListener('dragleave', () => this.listEl.classList.remove('drop'));
    this.listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.listEl.classList.remove('drop');
      const files = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
      if (files.length) void this.upload(files);
    });
    this.listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selected.size) void this.deleteSelected();
      if (e.key === 'Backspace') void this.go(parentOf(this.cwd));
      if (e.key === 'F5') void this.refresh();
    });

    this.offProgress = api.sftp.onProgress((id, p) => {
      if (id !== this.connId) return;
      const { file, transferred, total } = p as { file: string; transferred: number; total: number };
      const pct = total ? Math.round((transferred / total) * 100) : 100;
      this.progressEl.classList.remove('hidden');
      this.progressEl.replaceChildren(
        el('div', { class: 'sftp-progress-label' }, `${file.split('/').pop()} — ${pct}% (${formatBytes(transferred)} / ${formatBytes(total)})`),
        el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${pct}%` })),
      );
      if (pct >= 100) setTimeout(() => this.progressEl.classList.add('hidden'), 1500);
    });
  }

  async init(): Promise<void> {
    await this.goHome();
  }

  destroy(): void {
    this.offProgress();
  }

  private async goHome(): Promise<void> {
    try {
      await this.go(await api.sftp.home(this.connId));
    } catch (e) {
      this.listEl.replaceChildren(el('div', { class: 'empty' }, `SFTP no disponible: ${errMsg(e)}`));
    }
  }

  async go(path: string): Promise<void> {
    try {
      this.entries = await api.sftp.list(this.connId, path);
      this.cwd = path;
      this.pathInput.value = path;
      this.selected.clear();
      this.render();
    } catch (e) {
      toast(`No se pudo abrir ${path}: ${errMsg(e)}`, 'error');
    }
  }

  refresh(): Promise<void> {
    return this.go(this.cwd);
  }

  private render(): void {
    const rows = this.entries
      .filter((e) => this.showHidden || !e.name.startsWith('.'))
      .map((e) => {
        const row = el('div', { class: `sftp-row${this.selected.has(e.path) ? ' sel' : ''}`, title: `${e.permissions}  ${e.path}` },
          icon(e.isDir ? 'folder' : 'file', 14),
          el('span', { class: 'name' }, e.name + (e.isLink ? ' →' : '')),
          el('span', { class: 'size' }, e.isDir ? '' : formatBytes(e.size)),
          el('span', { class: 'date' }, new Date(e.mtime).toLocaleDateString()),
        );
        row.addEventListener('click', (ev) => {
          if (!(ev.ctrlKey || ev.metaKey)) this.selected.clear();
          if (this.selected.has(e.path)) this.selected.delete(e.path);
          else this.selected.add(e.path);
          this.render();
        });
        row.addEventListener('dblclick', () => (e.isDir ? void this.go(e.path) : void this.edit(e)));
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!this.selected.has(e.path)) {
            this.selected.clear();
            this.selected.add(e.path);
            this.render();
          }
          contextMenu(ev.clientX, ev.clientY, [
            { label: e.isDir ? 'Abrir' : 'Editar', action: () => (e.isDir ? void this.go(e.path) : void this.edit(e)) },
            { label: 'Descargar', action: () => void this.download() },
            { label: 'Renombrar…', action: () => void this.rename(e) },
            { label: 'Permisos…', action: () => void this.chmod(e) },
            { label: 'Copiar ruta', action: () => void navigator.clipboard.writeText(e.path) },
            { separator: true, label: '' },
            { label: 'Eliminar', danger: true, action: () => void this.deleteSelected() },
          ]);
        });
        return row;
      });
    this.listEl.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty' }, 'Carpeta vacía. Arrastra archivos aquí para subirlos.')]));
  }

  private async upload(paths?: string[]): Promise<void> {
    try {
      if (await api.sftp.upload(this.connId, this.cwd, paths)) {
        toast('Subida completada', 'ok');
        await this.refresh();
      }
    } catch (e) {
      toast(`Error al subir: ${errMsg(e)}`, 'error');
    }
  }

  private async download(): Promise<void> {
    if (!this.selected.size) return toast('Selecciona archivos o carpetas para descargar.');
    try {
      const dest = await api.sftp.download(this.connId, [...this.selected]);
      if (dest) toast(`Descargado en ${dest}`, 'ok');
    } catch (e) {
      toast(`Error al descargar: ${errMsg(e)}`, 'error');
    }
  }

  private async mkdir(): Promise<void> {
    const name = await promptDialog('Nueva carpeta', 'Nombre');
    if (!name) return;
    try {
      await api.sftp.mkdir(this.connId, joinPath(this.cwd, name));
      await this.refresh();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  private async rename(e: SftpEntry): Promise<void> {
    const name = await promptDialog('Renombrar', 'Nuevo nombre', e.name);
    if (!name || name === e.name) return;
    try {
      await api.sftp.rename(this.connId, e.path, joinPath(this.cwd, name));
      await this.refresh();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  private async chmod(e: SftpEntry): Promise<void> {
    const v = await promptDialog('Permisos', `Modo octal para ${e.name} (actual ${e.permissions})`, (e.mode & 0o7777).toString(8));
    if (!v) return;
    if (!/^[0-7]{3,4}$/.test(v)) return toast('Introduce un modo octal válido, p. ej. 644.', 'error');
    try {
      await api.sftp.chmod(this.connId, e.path, parseInt(v, 8));
      await this.refresh();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  private async deleteSelected(): Promise<void> {
    const items = this.entries.filter((x) => this.selected.has(x.path));
    if (!items.length) return;
    const ok = await confirmDialog('Eliminar', `¿Eliminar ${items.length === 1 ? `"${items[0].name}"` : `${items.length} elementos`}? Las carpetas se borran con todo su contenido.`, 'Eliminar', true);
    if (!ok) return;
    try {
      for (const it of items) await api.sftp.delete(this.connId, it.path, it.isDir && !it.isLink);
      await this.refresh();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  private async edit(e: SftpEntry): Promise<void> {
    let content: string;
    try {
      content = await api.sftp.readText(this.connId, e.path);
    } catch (err) {
      return toast(errMsg(err), 'error');
    }
    const ta = el('textarea', { class: 'editor', spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = content;
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      }
    });
    await modal(`Editar ${e.path}`, ta, [
      { label: 'Cerrar', value: true, kind: 'ghost' },
      {
        label: 'Guardar',
        kind: 'primary',
        value: async () => {
          await api.sftp.writeText(this.connId, e.path, ta.value);
          toast('Guardado', 'ok');
          return true;
        },
      },
    ], { wide: true, dismiss: true });
  }
}

function parentOf(p: string): string {
  if (p === '/' || !p) return '/';
  const parts = p.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}
