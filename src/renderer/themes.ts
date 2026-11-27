import type { ITheme } from '@xterm/xterm';
import type { ThemeDef } from '../shared/types';

export interface AppTheme extends Omit<ThemeDef, 'term'> {
  term: ITheme;
  /** De dónde viene: integrado, propio (editable) o de un plugin. */
  origin?: 'builtin' | 'custom' | 'plugin';
}

const base16 = (c: string[]): Partial<ITheme> => ({
  black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
});

export const THEMES: AppTheme[] = [
  {
    id: 'nexus-dark',
    name: 'Nexus oscuro',
    dark: true,
    ui: { bg: '#0f1419', panel: '#151b23', panel2: '#1c2430', border: '#263140', text: '#d8e0ea', muted: '#7d8a9c', accent: '#2dd4bf', accent2: '#818cf8', danger: '#f87171', warn: '#fbbf24' },
    term: {
      background: '#0b0f14', foreground: '#d8e0ea', cursor: '#2dd4bf', cursorAccent: '#0b0f14', selectionBackground: '#2dd4bf44',
      ...base16(['#1c2430', '#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#2dd4bf', '#d8e0ea', '#475569', '#fca5a5', '#86efac', '#fde68a', '#93c5fd', '#d8b4fe', '#5eead4', '#ffffff']),
    },
  },
  {
    id: 'nexus-light',
    name: 'Nexus claro',
    dark: false,
    ui: { bg: '#f4f6f9', panel: '#ffffff', panel2: '#eef1f5', border: '#d5dbe3', text: '#1e293b', muted: '#64748b', accent: '#0d9488', accent2: '#4f46e5', danger: '#dc2626', warn: '#b45309' },
    term: {
      background: '#ffffff', foreground: '#1e293b', cursor: '#0d9488', cursorAccent: '#ffffff', selectionBackground: '#0d948833',
      ...base16(['#1e293b', '#dc2626', '#16a34a', '#b45309', '#2563eb', '#9333ea', '#0d9488', '#cbd5e1', '#64748b', '#ef4444', '#22c55e', '#d97706', '#3b82f6', '#a855f7', '#14b8a6', '#f8fafc']),
    },
  },
  {
    id: 'midnight',
    name: 'Medianoche',
    dark: true,
    ui: { bg: '#0a0a14', panel: '#11111f', panel2: '#191930', border: '#262645', text: '#e2e2f5', muted: '#8484a8', accent: '#a78bfa', accent2: '#f472b6', danger: '#fb7185', warn: '#facc15' },
    term: {
      background: '#07070f', foreground: '#e2e2f5', cursor: '#a78bfa', cursorAccent: '#07070f', selectionBackground: '#a78bfa44',
      ...base16(['#191930', '#fb7185', '#34d399', '#facc15', '#818cf8', '#f472b6', '#22d3ee', '#e2e2f5', '#4b4b70', '#fda4af', '#6ee7b7', '#fde047', '#a5b4fc', '#f9a8d4', '#67e8f9', '#ffffff']),
    },
  },
  {
    id: 'solar-dark',
    name: 'Solar oscuro',
    dark: true,
    ui: { bg: '#00212b', panel: '#002b36', panel2: '#073642', border: '#0d4654', text: '#d0dcdc', muted: '#839496', accent: '#2aa198', accent2: '#268bd2', danger: '#dc322f', warn: '#b58900' },
    term: {
      background: '#002b36', foreground: '#c5d1d1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#93a1a144',
      ...base16(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#93a1a1', '#b5a46a', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
    },
  },
  {
    id: 'forest',
    name: 'Bosque',
    dark: true,
    ui: { bg: '#0f1510', panel: '#151d16', panel2: '#1c271d', border: '#2a3a2b', text: '#dbe7d6', muted: '#86a083', accent: '#a3e635', accent2: '#34d399', danger: '#f87171', warn: '#fbbf24' },
    term: {
      background: '#0c110d', foreground: '#dbe7d6', cursor: '#a3e635', cursorAccent: '#0c110d', selectionBackground: '#a3e63544',
      ...base16(['#1c271d', '#f87171', '#a3e635', '#fbbf24', '#60a5fa', '#c084fc', '#34d399', '#dbe7d6', '#4d644e', '#fca5a5', '#bef264', '#fde68a', '#93c5fd', '#d8b4fe', '#6ee7b7', '#ffffff']),
    },
  },
];

let custom: AppTheme[] = [];
const fromPlugins = new Map<string, AppTheme>();

export function setCustomThemes(list: ThemeDef[]): void {
  custom = list.map((t) => ({ ...t, term: t.term as ITheme, origin: 'custom' }));
}

export function addPluginTheme(t: ThemeDef): void {
  fromPlugins.set(t.id, { ...t, term: t.term as ITheme, origin: 'plugin' });
}

export function removePluginThemes(prefix: string): void {
  for (const id of [...fromPlugins.keys()]) if (id.startsWith(prefix)) fromPlugins.delete(id);
}

/** Todos los temas: integrados, propios y de plugins. */
export function allThemes(): AppTheme[] {
  return [...THEMES.map((t) => ({ ...t, origin: 'builtin' as const })), ...custom, ...fromPlugins.values()];
}

export function themeById(id: string): AppTheme {
  return allThemes().find((t) => t.id === id) || THEMES[0];
}

export function applyUiTheme(t: AppTheme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.ui)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('--term-bg', t.term.background || '#000');
  root.dataset.theme = t.dark ? 'dark' : 'light';
}

/** El tema como ThemeDef (para editarlo, exportarlo o guardarlo). */
export function toDef(t: AppTheme): ThemeDef {
  const { origin: _o, ...rest } = t;
  return { ...rest, term: { ...(t.term as Record<string, string>) } };
}
