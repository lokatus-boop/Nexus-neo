// Ejecuta los plugins activados, cada uno en su propio Web Worker. El worker no tiene acceso
// a Node, al DOM ni a la red: sólo a la API «nexus» que se le da aquí, y cada llamada se
// comprueba contra los permisos que el usuario aceptó.
import type { PluginManifest, PluginPermission, ThemeDef } from '../shared/types';
import { normalizeTheme } from '../shared/theme-format';

export interface HostHooks {
  activeTab(): { connId: string; title: string } | null;
  write(connId: string, data: string): void;
  notify(msg: string, kind: 'info' | 'ok' | 'error'): void;
  prompt(title: string, label: string): Promise<string | null>;
  registerTheme(t: ThemeDef): void;
  listSessions(): { name: string; kind: string; host?: string; folder: string }[];
  setStatus(pluginId: string, text: string): void;
  storageGet(pluginId: string, key: string): Promise<unknown>;
  storageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  commandsChanged(): void;
  log(pluginId: string, msg: string): void;
}

export interface PluginCommand {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  run(): void;
}

/** Código que se ejecuta en el worker antes que el del plugin. */
function prelude(m: PluginManifest): string {
  return `"use strict";
(() => {
  // Sin red ni carga de código externo dentro del plugin.
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'indexedDB', 'caches']) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) { try { delete o[n]; } catch {} }
    try { Object.defineProperty(self, n, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  const calls = new Map();
  let seq = 0;
  const commands = new Map();
  const outputs = [];
  const post = self.postMessage.bind(self);
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject });
    post({ t: 'call', id, method, args });
  });
  self.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'ret') {
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (c) m.error ? c.reject(new Error(m.error)) : c.resolve(m.value);
    } else if (m.t === 'command') {
      const f = commands.get(m.id);
      if (f) Promise.resolve().then(f).catch((err) => call('log', 'Error en el comando ' + m.id + ': ' + (err && err.message || err)));
    } else if (m.t === 'output') {
      for (const f of outputs) { try { f(m.payload); } catch (err) { call('log', String(err && err.message || err)); } }
    }
  };
  self.nexus = Object.freeze({
    plugin: Object.freeze(${JSON.stringify({ id: m.id, name: m.name, version: m.version })}),
    commands: Object.freeze({
      register(id, label, fn) {
        if (typeof fn !== 'function') throw new Error('register(id, etiqueta, función)');
        commands.set(String(id), fn);
        return call('registerCommand', String(id), String(label));
      },
    }),
    terminal: Object.freeze({
      send: (text) => call('send', String(text)),
      active: () => call('activeTab'),
      onOutput(fn) {
        outputs.push(fn);
        return call('subscribeOutput');
      },
    }),
    ui: Object.freeze({
      notify: (msg, kind) => call('notify', String(msg), kind),
      prompt: (title, label) => call('prompt', String(title), String(label || '')),
      setStatus: (text) => call('setStatus', String(text || '')),
    }),
    themes: Object.freeze({ register: (t) => call('registerTheme', t) }),
    sessions: Object.freeze({ list: () => call('listSessions') }),
    storage: Object.freeze({ get: (k) => call('storageGet', String(k)), set: (k, v) => call('storageSet', String(k), v) }),
    log: (...a) => call('log', a.map(String).join(' ')),
  });
})();
`;
}

interface Running {
  manifest: PluginManifest;
  permissions: PluginPermission[];
  worker: Worker;
  url: string;
  commands: Map<string, string>;
  wantsOutput: boolean;
  outBuf: { connId: string; title: string; data: string }[];
  outTimer: number | null;
}

export class PluginHost {
  private running = new Map<string, Running>();
  readonly errors = new Map<string, string>();

  constructor(private readonly hooks: HostHooks) {}

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  start(manifest: PluginManifest, code: string, permissions: PluginPermission[]): void {
    this.stop(manifest.id);
    this.errors.delete(manifest.id);
    const url = URL.createObjectURL(new Blob([prelude(manifest), '\n;\n', code, `\n//# sourceURL=plugin://${manifest.id}/${manifest.main || 'main.js'}`], { type: 'text/javascript' }));
    const worker = new Worker(url, { name: `plugin:${manifest.id}` });
    const r: Running = { manifest, permissions, worker, url, commands: new Map(), wantsOutput: false, outBuf: [], outTimer: null };
    this.running.set(manifest.id, r);
    worker.onmessage = (e) => void this.onCall(r, e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      const msg = `${e.message}${e.lineno ? ` (línea ${e.lineno})` : ''}`;
      this.errors.set(manifest.id, msg);
      this.hooks.log(manifest.id, msg);
    };
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.worker.terminate();
    URL.revokeObjectURL(r.url);
    if (r.outTimer) clearTimeout(r.outTimer);
    this.running.delete(id);
    this.hooks.setStatus(id, '');
    this.hooks.commandsChanged();
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  commands(): PluginCommand[] {
    const out: PluginCommand[] = [];
    for (const [pid, r] of this.running) {
      for (const [id, label] of r.commands) out.push({ pluginId: pid, pluginName: r.manifest.name, id, label, run: () => r.worker.postMessage({ t: 'command', id }) });
    }
    return out;
  }

  /** Salida de un terminal: se reparte (agrupada cada 50 ms) a los plugins suscritos. */
  output(connId: string, title: string, data: string): void {
    for (const r of this.running.values()) {
      if (!r.wantsOutput) continue;
      r.outBuf.push({ connId, title, data });
      r.outTimer ??= window.setTimeout(() => {
        r.outTimer = null;
        const merged = new Map<string, { connId: string; title: string; data: string }>();
        for (const o of r.outBuf.splice(0)) {
          const m = merged.get(o.connId);
          if (m) m.data += o.data;
          else merged.set(o.connId, { ...o });
        }
        for (const payload of merged.values()) r.worker.postMessage({ t: 'output', payload });
      }, 50);
    }
  }

  private need(r: Running, p: PluginPermission): void {
    if (!r.permissions.includes(p)) throw new Error(`El plugin no tiene el permiso «${p}». Añádelo a «permissions» en manifest.json.`);
  }

  private async onCall(r: Running, msg: { t: string; id: number; method: string; args: unknown[] }): Promise<void> {
    if (!msg || msg.t !== 'call') return;
    const id = r.manifest.id;
    const a = msg.args || [];
    let value: unknown = null;
    try {
      switch (msg.method) {
        case 'registerCommand':
          if (r.commands.size >= 50 && !r.commands.has(String(a[0]))) throw new Error('Demasiados comandos.');
          r.commands.set(String(a[0]), String(a[1]).slice(0, 80));
          this.hooks.commandsChanged();
          break;
        case 'send': {
          this.need(r, 'terminal:write');
          const t = this.hooks.activeTab();
          if (!t) throw new Error('No hay ningún terminal activo.');
          this.hooks.write(t.connId, String(a[0]));
          break;
        }
        case 'activeTab':
          this.need(r, 'terminal:read');
          value = this.hooks.activeTab();
          break;
        case 'subscribeOutput':
          this.need(r, 'terminal:read');
          r.wantsOutput = true;
          break;
        case 'notify':
          this.hooks.notify(`${r.manifest.name}: ${String(a[0]).slice(0, 300)}`, a[1] === 'error' || a[1] === 'ok' ? a[1] : 'info');
          break;
        case 'prompt':
          value = await this.hooks.prompt(`${r.manifest.name}: ${String(a[0]).slice(0, 80)}`, String(a[1]).slice(0, 200));
          break;
        case 'setStatus':
          this.hooks.setStatus(id, String(a[0]).slice(0, 60));
          break;
        case 'registerTheme': {
          const t = normalizeTheme(a[0]);
          this.hooks.registerTheme({ ...t, id: `plugin-${id}-${t.id.replace(/^custom-/, '')}` });
          break;
        }
        case 'listSessions':
          this.need(r, 'sessions:read');
          value = this.hooks.listSessions();
          break;
        case 'storageGet':
          value = await this.hooks.storageGet(id, String(a[0]));
          break;
        case 'storageSet':
          await this.hooks.storageSet(id, String(a[0]), a[1]);
          break;
        case 'log':
          this.hooks.log(id, String(a[0]).slice(0, 1000));
          break;
        default:
          throw new Error(`Función desconocida: ${msg.method}`);
      }
      r.worker.postMessage({ t: 'ret', id: msg.id, value });
    } catch (e) {
      r.worker.postMessage({ t: 'ret', id: msg.id, error: (e as Error).message });
    }
  }
}
