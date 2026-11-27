import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseThemeFile, normalizeTheme, deriveUi, contrast, hex6, exportTheme, ANSI_KEYS } from '../src/shared/theme-format';
import { PluginManager, validateManifest } from '../src/main/plugins';
import { Store } from '../src/main/store';

const WT = {
  name: 'Campbell Plus',
  background: '#0C0C0C', foreground: '#CCCCCC', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF',
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
};

test('temas: esquema de Windows Terminal suelto, en lista y en settings.json', () => {
  const [t] = parseThemeFile(JSON.stringify(WT));
  assert.equal(t.name, 'Campbell Plus');
  assert.equal(t.id, 'custom-campbell-plus');
  assert.equal(t.term.magenta, '#881798');
  assert.equal(t.term.cursor, '#FFFFFF');
  assert.equal(t.term.selectionBackground, '#FFFFFF66');
  assert.equal(t.dark, true);
  for (const k of ANSI_KEYS) assert.ok(t.term[k], k);
  for (const k of ['bg', 'panel', 'panel2', 'border', 'text', 'muted', 'accent', 'accent2', 'danger', 'warn']) assert.match(t.ui[k], /^#[0-9a-f]{6}$/, k);
  assert.ok(contrast(t.ui.text, t.ui.panel) > 4.5);
  assert.equal(parseThemeFile(JSON.stringify([WT, { ...WT, name: 'Otro' }])).length, 2);
  const settings = `{
    // comentario de Windows Terminal
    "profiles": {},
    "schemes": [ ${JSON.stringify(WT)}, ],
  }`;
  assert.equal(parseThemeFile(settings, 'settings.json')[0].name, 'Campbell Plus');
});

test('temas: .itermcolors de iTerm2', () => {
  const color = (k: string, r: number, g: number, b: number) => `<key>${k}</key><dict><key>Blue Component</key><real>${b}</real><key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`;
  const xml = `<?xml version="1.0"?><plist><dict>${color('Background Color', 1, 1, 1)}${color('Foreground Color', 0, 0, 0)}${color('Ansi 1 Color', 0.8, 0, 0)}${color('Ansi 12 Color', 0, 0, 1)}</dict></plist>`;
  const [t] = parseThemeFile(xml, '/ruta/Solarizado Claro.itermcolors');
  assert.equal(t.name, 'Solarizado Claro');
  assert.equal(t.term.background, '#ffffff');
  assert.equal(t.term.red, '#cc0000');
  assert.equal(t.term.brightBlue, '#0000ff');
  assert.equal(t.dark, false);
  assert.throws(() => parseThemeFile('<plist></plist>'), /colores/);
});

test('temas: formato propio, validación y exportación', () => {
  const t = normalizeTheme({ id: 'mi-tema', name: 'Mi tema', term: { background: '#101010', foreground: '#eeeeee' }, ui: { accent: '#ff00ff' } });
  assert.equal(t.id, 'mi-tema');
  assert.equal(t.ui.accent, '#ff00ff');
  assert.equal(t.term.cursor, '#eeeeee');
  const again = parseThemeFile(exportTheme({ ...t, updatedAt: 5 }));
  assert.deepEqual(again[0], { ...t, updatedAt: undefined });
  assert.doesNotMatch(exportTheme({ ...t, updatedAt: 5 }), /updatedAt/);
  assert.throws(() => normalizeTheme({ name: 'x', term: { background: 'rojo' } }), /Color no válido.*background/);
  assert.throws(() => normalizeTheme({ term: {} }), /nombre/);
  assert.throws(() => parseThemeFile('{"hola": 1}'), /no reconocido/);
  assert.throws(() => parseThemeFile('esto no es json'), /JSON/);
  // Un id con caracteres raros se sustituye por uno seguro.
  assert.equal(normalizeTheme({ id: '../x', name: 'Árbol Ñandú', term: {} }).id, 'custom-arbol-nandu');
});

test('temas: colores y deducción de la interfaz', () => {
  assert.equal(hex6('#abc'), '#aabbcc');
  assert.equal(hex6('#11223344'), '#112233');
  assert.equal(hex6('rgba(255, 0, 16, .5)'), '#ff0010');
  const light = deriveUi({ background: '#fafafa', foreground: '#222222', blue: '#0040ff', cyan: '#00a0a0' });
  assert.equal(light.dark, false);
  assert.equal(light.ui.accent, '#0040ff', 'el acento es el color con más contraste');
  assert.ok(contrast(light.ui.muted, light.ui.panel) > 2);
});

test('plugins: validación del manifiesto', () => {
  const ok = validateManifest({ id: 'mi-plugin', name: ' Mi plugin ', version: '1.2.3', permissions: ['terminal:read', 'terminal:read'] }, 'mi-plugin');
  assert.deepEqual(ok, { id: 'mi-plugin', name: 'Mi plugin', version: '1.2.3', description: undefined, author: undefined, main: 'main.js', permissions: ['terminal:read'] });
  assert.throws(() => validateManifest({ id: 'Mal Id', name: 'x', version: '1.0' }), /id/);
  assert.throws(() => validateManifest({ id: 'abc', name: 'x', version: '1.0' }, 'otra'), /coincidir/);
  assert.throws(() => validateManifest({ id: 'abc', name: 'x', version: 'uno' }), /version/);
  assert.throws(() => validateManifest({ id: 'abc', name: 'x', version: '1.0', main: '../fuera.js' }), /main/);
  assert.throws(() => validateManifest({ id: 'abc', name: 'x', version: '1.0', permissions: ['fs:write'] }), /Permiso desconocido/);
});

test('plugins: instalar, listar, permisos, código, almacenamiento y quitar', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nexus-plugins-'));
  try {
    const pm = new PluginManager(join(root, 'plugins'), join(root, 'plugin-data'));
    // El ejemplo incluido en el repositorio se instala y es válido.
    const m = await pm.install(join(process.cwd(), 'examples/plugins/marcas-de-tiempo'));
    assert.equal(m.id, 'marcas-de-tiempo');
    // Una carpeta rota se lista con su error.
    await fs.mkdir(join(root, 'plugins', 'roto'));
    await fs.writeFile(join(root, 'plugins', 'roto', 'manifest.json'), '{ no es json');
    let list = await pm.list({ plugins: {} });
    assert.deepEqual(list.map((p) => [p.id, p.enabled, !!p.error]), [['marcas-de-tiempo', false, false], ['roto', false, true]]);
    // Sin activar no se entrega el código.
    await assert.rejects(pm.code('marcas-de-tiempo', { plugins: {} }), /no está activado/);
    // Activado con menos permisos de los que pide: necesita aprobación y no se carga.
    const partial = { plugins: { 'marcas-de-tiempo': { permissions: ['terminal:read' as const] } } };
    list = await pm.list(partial);
    assert.equal(list[0].needsApproval, true);
    await assert.rejects(pm.code('marcas-de-tiempo', partial), /permisos nuevos/);
    const full = { plugins: { 'marcas-de-tiempo': { permissions: ['terminal:read' as const, 'terminal:write' as const] } } };
    const { code } = await pm.code('marcas-de-tiempo', full);
    assert.match(code, /nexus\.commands\.register/);
    // Almacenamiento propio.
    assert.equal(await pm.storageGet('marcas-de-tiempo', 'autor'), null);
    await pm.storageSet('marcas-de-tiempo', 'autor', 'Ana');
    assert.equal(await pm.storageGet('marcas-de-tiempo', 'autor'), 'Ana');
    await assert.rejects(pm.storageSet('../../x', 'a', 1), /no válido/);
    await pm.remove('marcas-de-tiempo');
    assert.equal(await pm.storageGet('marcas-de-tiempo', 'autor'), null);
    assert.deepEqual((await pm.list({ plugins: {} })).map((p) => p.id), ['roto']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('store: temas y plantillas propios con marcas de borrado para la sincronización', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'nexus-store-'));
  try {
    const store = new Store(dir);
    await store.init();
    let changes = 0;
    store.onChange = () => changes++;
    const t = await store.saveTheme(normalizeTheme({ name: 'Uno', term: {} }));
    assert.ok(t.updatedAt);
    await store.saveTemplate({ id: '', name: 'Acceso', body: 'hostname {{name}}' });
    assert.equal((await store.listTemplates())[0].name, 'Acceso');
    await store.deleteTheme(t.id);
    assert.deepEqual(await store.listThemes(), []);
    assert.ok((await store.tombstones())[`themes:${t.id}`]);
    assert.equal(changes, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
