// Motor de macros: interpreta el texto de una macro y lo convierte en pasos.
// Sintaxis: texto literal con escapes \n (Intro), \r, \t, \e (Esc), \\ , \xHH
// y directivas {sleep:500} (pausa en ms) y {{ / }} para llaves literales.

export type MacroStep = { type: 'text'; text: string } | { type: 'sleep'; ms: number };

export function parseMacro(body: string): MacroStep[] {
  const steps: MacroStep[] = [];
  let buf = '';
  const flush = () => {
    if (buf) steps.push({ type: 'text', text: buf });
    buf = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const n = body[++i];
      if (n === 'n' || n === 'r') buf += '\r';
      else if (n === 't') buf += '\t';
      else if (n === 'e') buf += '\x1b';
      else if (n === '\\') buf += '\\';
      else if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
        buf += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
        i += 2;
      } else buf += '\\' + n;
    } else if (c === '{' && body[i + 1] === '{') {
      buf += '{';
      i++;
    } else if (c === '}' && body[i + 1] === '}') {
      buf += '}';
      i++;
    } else if (c === '{') {
      const end = body.indexOf('}', i);
      const m = end > 0 ? /^sleep:(\d+)$/.exec(body.slice(i + 1, end).trim()) : null;
      if (m) {
        flush();
        steps.push({ type: 'sleep', ms: Math.min(Number(m[1]), 600_000) });
        i = end;
      } else buf += c;
    } else if (c === '\n') {
      // Un salto de línea real en el editor equivale a Intro.
      buf += '\r';
    } else {
      buf += c;
    }
  }
  flush();
  return steps;
}

/** Convierte datos grabados del terminal a texto de macro legible. */
export function encodeRecording(data: string): string {
  let out = '';
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (ch === '\r') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\x1b') out += '\\e';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '{{';
    else if (ch === '}') out += '}}';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

export async function runMacro(steps: MacroStep[], write: (text: string) => void, signal?: AbortSignal): Promise<void> {
  for (const s of steps) {
    if (signal?.aborted) return;
    if (s.type === 'text') write(s.text);
    else await new Promise((r) => setTimeout(r, s.ms));
  }
}
