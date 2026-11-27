// Formatos de temas: el propio de Nexus Neo (JSON), los esquemas de color de Windows Terminal
// (sueltos, en lista o dentro de settings.json) y los .itermcolors de iTerm2. De un esquema de
// terminal se deducen también los colores de la interfaz.
import type { ThemeDef } from './types';

export const UI_KEYS = ['bg', 'panel', 'panel2', 'border', 'text', 'muted', 'accent', 'accent2', 'danger', 'warn'] as const;
export const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
export const TERM_KEYS = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', ...ANSI_KEYS] as const;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColor(c: unknown): c is string {
  return typeof c === 'string' && (HEX.test(c) || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/i.test(c));
}

/** #rgb / #rrggbb / #rrggbbaa → [r, g, b, a]. */
export function parseHex(c: string): [number, number, number, number] {
  let h = c.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

export function toHex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Color en #rrggbb (sin transparencia), para los selectores de color. */
export function hex6(c: string): string {
  if (HEX.test(c)) return toHex(parseHex(c));
  const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  return m ? toHex([+m[1], +m[2], +m[3]]) : '#000000';
}

export function mix(a: string, b: string, t: number): string {
  const x = parseHex(hex6(a));
  const y = parseHex(hex6(b));
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}

export function luminance(c: string): number {
  const [r, g, b] = parseHex(hex6(c)).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Colores de la interfaz deducidos de los del terminal. */
export function deriveUi(term: Record<string, string>): { dark: boolean; ui: Record<string, string> } {
  const bg = hex6(term.background || '#000000');
  const fg = hex6(term.foreground || '#ffffff');
  const dark = luminance(bg) < 0.4;
  // El acento es el color ANSI con más contraste sobre el fondo entre cian, azul, verde y magenta.
  const candidates = [term.cyan, term.blue, term.green, term.magenta, term.brightCyan, term.brightBlue].filter(isColor).map(hex6);
  const accent = candidates.sort((a, b) => contrast(b, bg) - contrast(a, bg))[0] || (dark ? '#2dd4bf' : '#0d9488');
  const accent2 = candidates.find((c) => c !== accent) || accent;
  const ui = {
    bg: mix(bg, dark ? '#000000' : '#ffffff', dark ? 0.15 : 0.4),
    panel: mix(bg, fg, 0.04),
    panel2: mix(bg, fg, 0.09),
    border: mix(bg, fg, 0.18),
    text: fg,
    muted: mix(fg, bg, 0.42),
    accent,
    accent2,
    danger: hex6(term.red || '#f87171'),
    warn: hex6(term.yellow || '#fbbf24'),
  };
  return { dark, ui };
}

export function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tema';
}

function completeTerm(term: Record<string, string>): Record<string, string> {
  const t = { ...term };
  t.background ||= '#000000';
  t.foreground ||= '#ffffff';
  t.cursor ||= t.foreground;
  t.cursorAccent ||= t.background;
  t.selectionBackground ||= `${hex6(t.foreground)}44`;
  return t;
}

/** Comprueba y completa un tema. Lanza un error legible si no es válido. */
export function normalizeTheme(raw: unknown): ThemeDef {
  const o = raw as Partial<ThemeDef>;
  if (!o || typeof o !== 'object') throw new Error('El tema no es un objeto JSON.');
  if (!o.name || typeof o.name !== 'string') throw new Error('El tema necesita un nombre («name»).');
  if (!o.term || typeof o.term !== 'object') throw new Error(`El tema «${o.name}» no tiene colores de terminal («term»).`);
  const term: Record<string, string> = {};
  for (const k of TERM_KEYS) {
    const v = (o.term as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!isColor(v)) throw new Error(`Color no válido en «${o.name}»: ${k} = ${JSON.stringify(v)}`);
    term[k] = v;
  }
  const full = completeTerm(term);
  const derived = deriveUi(full);
  const ui: Record<string, string> = { ...derived.ui };
  for (const k of UI_KEYS) {
    const v = (o.ui as Record<string, unknown> | undefined)?.[k];
    if (v === undefined) continue;
    if (!isColor(v)) throw new Error(`Color no válido en «${o.name}»: ui.${k} = ${JSON.stringify(v)}`);
    ui[k] = v;
  }
  return { id: o.id && /^[\w-]{1,60}$/.test(o.id) ? o.id : `custom-${slug(o.name)}`, name: o.name.slice(0, 60), dark: typeof o.dark === 'boolean' ? o.dark : derived.dark, ui, term: full, updatedAt: o.updatedAt };
}

/** Esquema de Windows Terminal → tema. */
export function fromWindowsTerminal(s: Record<string, unknown>): ThemeDef {
  const term: Record<string, string> = {};
  const map: Record<string, string> = { background: 'background', foreground: 'foreground', cursorColor: 'cursor', selectionBackground: 'selectionBackground', purple: 'magenta', brightPurple: 'brightMagenta' };
  for (const [k, v] of Object.entries(s)) {
    const key = map[k] || (ANSI_KEYS as readonly string[]).find((a) => a === k);
    if (key && isColor(v)) term[key] = v;
  }
  if (term.selectionBackground && /^#[0-9a-f]{6}$/i.test(term.selectionBackground)) term.selectionBackground += '66';
  return normalizeTheme({ name: String(s.name || 'Importado'), term });
}

/** .itermcolors (plist XML) → tema. */
export function fromIterm(xml: string, name: string): ThemeDef {
  const term: Record<string, string> = {};
  const keyMap: Record<string, string> = { 'Background Color': 'background', 'Foreground Color': 'foreground', 'Cursor Color': 'cursor', 'Cursor Text Color': 'cursorAccent', 'Selection Color': 'selectionBackground' };
  ANSI_KEYS.forEach((k, i) => (keyMap[`Ansi ${i} Color`] = k));
  const re = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (const m of xml.matchAll(re)) {
    const key = keyMap[m[1].trim()];
    if (!key) continue;
    const comp = (c: string) => {
      const r = new RegExp(`<key>${c} Component</key>\\s*<real>([\\d.eE+-]+)</real>`).exec(m[2]);
      return r ? Number(r[1]) * 255 : 0;
    };
    term[key] = toHex([comp('Red'), comp('Green'), comp('Blue')]);
  }
  if (!term.background && !term.black) throw new Error('El archivo .itermcolors no tiene colores reconocibles.');
  return normalizeTheme({ name, term });
}

/**
 * Lee un archivo de temas y devuelve los temas que contiene: tema de Nexus Neo (o lista),
 * esquema de Windows Terminal (o lista, o settings.json con «schemes») o .itermcolors.
 */
export function parseThemeFile(text: string, fileName = 'tema'): ThemeDef[] {
  const t = text.replace(/^﻿/, '').trim();
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  if (t.startsWith('<')) return [fromIterm(t, base)];
  let data: unknown;
  try {
    // settings.json de Windows Terminal admite comentarios // y comas finales.
    data = JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    throw new Error('El archivo no es JSON válido ni un .itermcolors.');
  }
  const one = (o: unknown): ThemeDef => {
    const r = o as Record<string, unknown>;
    if (r && typeof r === 'object' && 'term' in r) return normalizeTheme(r);
    if (r && typeof r === 'object' && ('background' in r || 'black' in r)) return fromWindowsTerminal(r);
    throw new Error('Formato de tema no reconocido: se esperaba un tema de Nexus Neo, un esquema de Windows Terminal o un .itermcolors.');
  };
  if (Array.isArray(data)) return data.map(one);
  const d = data as Record<string, unknown>;
  if (Array.isArray(d?.schemes)) {
    if (!d.schemes.length) throw new Error('El settings.json no contiene esquemas de color.');
    return d.schemes.map(one);
  }
  return [one(d)];
}

/** JSON listo para compartir (sin marcas internas). */
export function exportTheme(t: ThemeDef): string {
  const { updatedAt: _u, ...rest } = t;
  return JSON.stringify(rest, null, 2) + '\n';
}
