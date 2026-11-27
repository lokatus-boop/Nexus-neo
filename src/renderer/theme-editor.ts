// Editor de temas: crea temas propios a partir de otro, ajusta cada color con vista previa en
// vivo, importa esquemas de Windows Terminal / iTerm2 / Nexus Neo y exporta a JSON.
import { api } from './api';
import { el, field, input, checkbox, modal, toast, errMsg, icon, confirmDialog } from './ui';
import { allThemes, applyUiTheme, setCustomThemes, themeById, toDef, AppTheme } from './themes';
import { ANSI_KEYS, UI_KEYS, hex6, parseThemeFile, deriveUi, slug, contrast } from '../shared/theme-format';
import type { ThemeDef } from '../shared/types';

const UI_LABEL: Record<string, string> = { bg: 'Fondo', panel: 'Paneles', panel2: 'Paneles 2', border: 'Bordes', text: 'Texto', muted: 'Texto tenue', accent: 'Acento', accent2: 'Acento 2', danger: 'Peligro', warn: 'Aviso' };
const TERM_LABEL: Record<string, string> = { background: 'Fondo', foreground: 'Texto', cursor: 'Cursor', cursorAccent: 'Texto bajo el cursor', selectionBackground: 'Selección' };
const ANSI_LABEL = ['Negro', 'Rojo', 'Verde', 'Amarillo', 'Azul', 'Magenta', 'Cian', 'Blanco'];

export async function refreshCustomThemes(): Promise<void> {
  setCustomThemes((await api.themes.list()) as ThemeDef[]);
}

function colorInput(value: string, onChange: (v: string) => void, withAlpha = false): HTMLElement {
  const pick = el('input', { type: 'color', value: hex6(value) });
  const text = input({ value, class: 'te-hex', spellcheck: 'false' });
  pick.addEventListener('input', () => {
    // Conserva la transparencia escrita a mano (p. ej. en la selección).
    const alpha = withAlpha && /^#[0-9a-f]{8}$/i.test(text.value) ? text.value.slice(7) : '';
    text.value = pick.value + alpha;
    onChange(text.value);
  });
  text.addEventListener('change', () => {
    pick.value = hex6(text.value);
    onChange(text.value.trim());
  });
  return el('span', { class: 'te-color' }, pick, text);
}

function preview(t: ThemeDef): HTMLElement {
  const c = t.term;
  const line = (...parts: [string, string][]) => el('div', {}, ...parts.map(([color, txt]) => el('span', { style: `color:${color}` }, txt)));
  const ansi = el('div', { class: 'te-swatches' }, ...ANSI_KEYS.map((k) => el('span', { style: `background:${c[k]}`, title: k })));
  return el('div', { class: 'te-preview', style: `background:${c.background};color:${c.foreground}` },
    line([c.green, 'admin@sw-core'], [c.foreground, ':'], [c.blue, '~'], [c.foreground, '$ '], [c.foreground, 'show interfaces status']),
    line([c.foreground, 'Gi1/0/1   '], [c.green, 'connected   '], [c.cyan, 'vlan 10   '], [c.yellow, 'a-1000 a-full']),
    line([c.foreground, 'Gi1/0/2   '], [c.red, 'notconnect  '], [c.cyan, 'vlan 20   '], [c.brightBlack, 'auto   auto']),
    line([c.magenta, '% Aviso: '], [c.brightYellow, 'puerto en err-disabled']),
    el('div', {}, el('span', { style: `background:${c.selectionBackground}` }, 'texto seleccionado'), ' ', el('span', { style: `background:${c.cursor};color:${c.cursorAccent}` }, ' ')),
    ansi,
  );
}

export async function themeEditor(currentId: string): Promise<string | null> {
  await refreshCustomThemes();
  let selected: AppTheme = themeById(currentId);
  let draft: ThemeDef = toDef(selected);
  let dirty = false;
  const list = el('div', { class: 'te-list' });
  const editor = el('div', { class: 'te-editor' });

  const apply = () => applyUiTheme({ ...draft, term: draft.term });
  const editable = () => selected.origin === 'custom' && draft.id === selected.id;

  const renderList = () => {
    list.replaceChildren(...allThemes().map((t) => el('button', {
      class: `te-item${t.id === selected.id ? ' active' : ''}`, type: 'button', 'data-theme': t.id,
      onclick: () => {
        selected = t;
        draft = toDef(t);
        dirty = false;
        render();
      },
    }, el('span', { class: 'te-dot', style: `background:${t.term.background};border-color:${t.ui.accent}` }), el('span', {}, t.name), el('small', {}, t.origin === 'custom' ? 'propio' : t.origin === 'plugin' ? 'plugin' : 'integrado'))));
  };

  const set = (path: 'ui' | 'term', k: string, v: string) => {
    draft = { ...draft, [path]: { ...draft[path], [k]: v } };
    dirty = true;
    apply();
    const p = editor.querySelector('.te-preview');
    p?.replaceWith(preview(draft));
    updateWarn();
  };
  const warn = el('p', { class: 'hint', id: 'te-warn' });
  const updateWarn = () => {
    const c = contrast(draft.term.foreground, draft.term.background);
    const u = contrast(draft.ui.text, draft.ui.panel);
    warn.textContent = c < 4.5 || u < 4.5 ? `⚠ Poco contraste (terminal ${c.toFixed(1)}:1, interfaz ${u.toFixed(1)}:1). Se recomienda al menos 4.5:1.` : `Contraste: terminal ${c.toFixed(1)}:1, interfaz ${u.toFixed(1)}:1.`;
  };

  const render = () => {
    renderList();
    apply();
    const name = input({ value: draft.name });
    name.addEventListener('input', () => {
      draft = { ...draft, name: name.value };
      dirty = true;
    });
    const dark = checkbox('Tema oscuro (para iconos y controles del sistema)', draft.dark);
    dark.box.addEventListener('change', () => {
      draft = { ...draft, dark: dark.box.checked };
      dirty = true;
      apply();
    });
    const derive = el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
      const d = deriveUi(draft.term);
      draft = { ...draft, dark: d.dark, ui: d.ui };
      dirty = true;
      render();
    } }, 'Deducir la interfaz de los colores del terminal');
    const ui = el('div', { class: 'te-grid' }, ...UI_KEYS.map((k) => field(UI_LABEL[k], colorInput(draft.ui[k], (v) => set('ui', k, v)))));
    const termBase = el('div', { class: 'te-grid' }, ...Object.keys(TERM_LABEL).map((k) => field(TERM_LABEL[k], colorInput(draft.term[k] || '#000000', (v) => set('term', k, v), k === 'selectionBackground'))));
    const ansi = el('div', { class: 'te-grid te-ansi' }, ...ANSI_KEYS.map((k, i) => field(`${i >= 8 ? 'Brillante ' : ''}${ANSI_LABEL[i % 8].toLowerCase()}`, colorInput(draft.term[k], (v) => set('term', k, v)))));
    const ro = !editable();
    editor.replaceChildren(
      ...(ro ? [el('p', { class: 'hint' }, `«${selected.name}» es un tema ${selected.origin === 'plugin' ? 'de un plugin' : 'integrado'}: los cambios se guardarán como un tema propio nuevo.`)] : []),
      el('div', { class: 'grid2' }, field('Nombre', name), el('div', {}, dark.wrap, derive)),
      preview(draft),
      warn,
      el('h3', {}, 'Interfaz'), ui,
      el('h3', {}, 'Terminal'), termBase, ansi,
    );
    updateWarn();
  };

  const save = async (): Promise<ThemeDef> => {
    if (!draft.name.trim()) throw new Error('Ponle un nombre al tema.');
    let t = draft;
    if (!editable()) {
      // Copia: id nuevo que no choque con los existentes.
      const base = `custom-${slug(draft.name)}`;
      let id = base;
      for (let i = 2; allThemes().some((x) => x.id === id); i++) id = `${base}-${i}`;
      t = { ...draft, id, name: draft.name === selected.name ? `${draft.name} (copia)` : draft.name };
    }
    const savedTheme = (await api.themes.save(t)) as ThemeDef;
    await refreshCustomThemes();
    selected = themeById(savedTheme.id);
    draft = toDef(selected);
    dirty = false;
    render();
    toast(`Tema «${savedTheme.name}» guardado`, 'ok');
    return savedTheme;
  };

  const importThemes = async () => {
    const text = el('textarea', { class: 'mono', rows: '10', spellcheck: 'false', placeholder: '{\n  "name": "Mi esquema",\n  "background": "#1e1e2e",\n  "foreground": "#cdd6f4",\n  "black": "#45475a", …\n}' });
    let fileName = 'importado';
    const fromFile = el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      const f = (await api.themes.pickFile()) as { name: string; text: string } | null;
      if (f) {
        text.value = f.text;
        fileName = f.name;
      }
    } }, 'Desde archivo…');
    const themes = await modal<ThemeDef[] | null>('Importar temas', el('div', { class: 'session-form' },
      el('p', {}, 'Admite temas de Nexus Neo, esquemas de color de Windows Terminal (uno, una lista o el settings.json entero) y archivos .itermcolors de iTerm2. Pega el contenido o elige el archivo.'),
      text, el('div', { class: 'row end' }, fromFile)), [
      { label: 'Cancelar', value: null, kind: 'ghost' },
      { label: 'Importar', kind: 'primary', value: () => parseThemeFile(text.value, fileName) },
    ], { wide: true, dismiss: null });
    if (!themes) return;
    let last: ThemeDef | null = null;
    for (const t of themes) {
      let id = t.id;
      for (let i = 2; allThemes().some((x) => x.id === id && x.origin !== 'custom'); i++) id = `${t.id}-${i}`;
      last = (await api.themes.save({ ...t, id })) as ThemeDef;
    }
    await refreshCustomThemes();
    if (last) {
      selected = themeById(last.id);
      draft = toDef(selected);
      dirty = false;
      render();
    }
    toast(themes.length === 1 ? `Tema «${themes[0].name}» importado` : `${themes.length} temas importados`, 'ok');
  };

  render();
  const result = await modal<string | null>('Temas', el('div', { class: 'te' }, el('div', { class: 'te-side' }, list,
    el('button', { class: 'btn ghost small', type: 'button', id: 'te-import', onclick: () => void importThemes().catch((e) => toast(errMsg(e), 'error')) }, icon('import'), ' Importar…'),
  ), editor), [
    { label: 'Exportar…', kind: 'ghost', value: async () => {
      const p = await api.themes.export(draft);
      if (p) toast(`Tema exportado a ${p}`, 'ok');
      return undefined as unknown as null; // el diálogo sigue abierto
    } },
    { label: 'Eliminar', kind: 'ghost', value: async () => {
      if (selected.origin !== 'custom') throw new Error('Sólo se pueden eliminar los temas propios.');
      if (!(await confirmDialog('Eliminar tema', `¿Eliminar «${selected.name}»?`, 'Eliminar', true))) return undefined as unknown as null;
      await api.themes.delete(selected.id);
      await refreshCustomThemes();
      selected = themeById(currentId === selected.id ? 'nexus-dark' : currentId);
      draft = toDef(selected);
      render();
      return undefined as unknown as null; // el diálogo sigue abierto
    } },
    { label: 'Guardar', kind: 'ghost', value: async () => {
      await save();
      return undefined as unknown as null; // el diálogo sigue abierto
    } },
    { label: 'Cerrar', kind: 'ghost', value: null },
    { label: 'Usar este tema', kind: 'primary', value: async () => {
      if (dirty) return (await save()).id;
      return selected.id;
    } },
  ], { wide: true, dismiss: null });
  return result;
}
