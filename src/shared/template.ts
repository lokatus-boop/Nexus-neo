// Plantillas de texto con variables {{nombre}} y utilidades para listas de equipos en CSV.
// Se usa en el despliegue masivo (órdenes por equipo) y en las plantillas de configuración.

export type Vars = Record<string, string>;

const VAR_RE = /\{\{\s*([\w.-]+)(?:\s*\|\s*([^}]*?))?\s*\}\}/g;

/** Variables que aparecen en una plantilla (sin repetir, en orden de aparición). */
export function templateVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Sustituye {{variable}} y {{variable | valor por defecto}}. Las variables sin valor ni
 * valor por defecto se devuelven en `missing` y se dejan tal cual en el texto.
 */
export function renderTemplate(text: string, vars: Vars): { text: string; missing: string[] } {
  const missing: string[] = [];
  const lower = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  const out = text.replace(VAR_RE, (whole, name: string, def?: string) => {
    const v = vars[name] ?? lower.get(name.toLowerCase());
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def.trim();
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { text: out, missing };
}

/** Lee CSV (coma o punto y coma, comillas dobles opcionales). La primera fila son las cabeceras. */
export function parseCsv(text: string): { headers: string[]; rows: Vars[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return { headers: [], rows: [] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const split = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) {
        cells.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const c = split(l);
    const r: Vars = {};
    headers.forEach((h, i) => (r[h] = c[i] ?? ''));
    return r;
  });
  return { headers, rows };
}

/** Nombre de archivo seguro a partir del nombre de un equipo. */
export function safeName(s: string): string {
  return s.replace(/[^\w.@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'equipo';
}

/** Diferencias línea a línea (LCS) entre dos textos, para comparar configuraciones. */
export type DiffLine = { op: ' ' | '+' | '-'; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.replace(/\r\n?/g, '\n').split('\n');
  const y = b.replace(/\r\n?/g, '\n').split('\n');
  // Recorta prefijo y sufijo comunes (lo normal en configuraciones) antes del LCS.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const n = xs.length;
  const m = ys.length;
  const out: DiffLine[] = x.slice(0, pre).map((text) => ({ op: ' ', text }));
  if (n * m > 25_000_000) {
    // Demasiado grande para LCS: se marca todo el bloque central como cambiado.
    out.push(...xs.map((text) => ({ op: '-' as const, text })), ...ys.map((text) => ({ op: '+' as const, text })));
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) {
        out.push({ op: ' ', text: xs[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: xs[i++] });
      else out.push({ op: '+', text: ys[j++] });
    }
    while (i < n) out.push({ op: '-', text: xs[i++] });
    while (j < m) out.push({ op: '+', text: ys[j++] });
  }
  out.push(...x.slice(x.length - suf).map((text) => ({ op: ' ' as const, text })));
  return out;
}

const COL: Record<string, 'name' | 'host' | 'protocol' | 'port' | 'username' | 'vendor'> = {
  name: 'name', nombre: 'name', equipo: 'name', hostname: 'name',
  host: 'host', ip: 'host', direccion: 'host', 'dirección': 'host', address: 'host',
  protocol: 'protocol', protocolo: 'protocol',
  port: 'port', puerto: 'port',
  username: 'username', user: 'username', usuario: 'username',
  vendor: 'vendor', fabricante: 'vendor', perfil: 'vendor',
};

/**
 * Lista de equipos desde CSV. Columnas reconocidas: name/nombre, host/ip, protocol (ssh|telnet),
 * port, username/usuario, vendor/fabricante. Las demás columnas son variables del equipo.
 */
export function devicesFromCsv(text: string): { id: string; name: string; host: string; port?: number; protocol: 'ssh' | 'telnet'; username?: string; vendor?: string; vars: Vars }[] {
  const { headers, rows } = parseCsv(text);
  // Para cada campo se usa la columna con su nombre exacto o, si no hay, el primer sinónimo;
  // el resto de sinónimos (p. ej. «ip» cuando ya hay «host») quedan como variables.
  const chosen = new Map<string, string>();
  for (const h of headers) {
    const k = COL[h.toLowerCase()];
    if (k && (h.toLowerCase() === k || !chosen.has(k))) chosen.set(k, h);
  }
  const keyOf = (h: string) => {
    const k = COL[h.toLowerCase()];
    return k && chosen.get(k) === h ? k : undefined;
  };
  if (!headers.some((h) => keyOf(h) === 'host')) {
    if (rows.length || headers.length) throw new Error('El CSV necesita una columna «host» (o «ip»).');
    return [];
  }
  return rows
    .map((r, i) => {
      const d: { id: string; name: string; host: string; port?: number; protocol: 'ssh' | 'telnet'; username?: string; vendor?: string; vars: Vars } = { id: `csv-${i + 1}`, name: '', host: '', protocol: 'ssh', vars: {} };
      for (const h of headers) {
        const v = r[h];
        const k = keyOf(h);
        if (k === 'port') d.port = Number(v) || undefined;
        else if (k === 'protocol') d.protocol = /telnet/i.test(v) ? 'telnet' : 'ssh';
        else if (k === 'name' || k === 'host') d[k] = v;
        else if (k === 'username' || k === 'vendor') d[k] = v || undefined;
        else d.vars[h] = v;
        // Las columnas reconocidas también se pueden usar como variables ({{ip}}, {{nombre}}…).
        if (k && h.toLowerCase() !== k) d.vars[h] = v;
      }
      d.name ||= d.host;
      return d;
    })
    .filter((d) => d.host);
}
