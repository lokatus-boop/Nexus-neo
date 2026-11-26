import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

function on(ch: string, fn: (...args: any[]) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]) => fn(...args);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
}

const api = {
  appInfo: invoke('app:info'),
  sessions: {
    list: invoke('sessions:list'),
    save: invoke('sessions:save'),
    delete: invoke('sessions:delete'),
    hasSecret: invoke('sessions:hasSecret'),
    clearSecret: invoke('sessions:clearSecret'),
    import: invoke('sessions:import'),
    export: invoke('sessions:export'),
  },
  macros: { list: invoke('macros:list'), save: invoke('macros:save'), delete: invoke('macros:delete') },
  settings: { get: invoke('settings:get'), save: invoke('settings:save') },
  vault: {
    status: invoke('vault:status'),
    create: invoke('vault:create'),
    unlock: invoke('vault:unlock'),
    lock: invoke('vault:lock'),
    change: invoke('vault:change'),
    onLocked: (fn: () => void) => on('vault:locked', fn),
  },
  conn: {
    open: invoke('conn:open'),
    close: invoke('conn:close'),
    write: (id: string, data: string) => ipcRenderer.send('conn:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('conn:resize', id, cols, rows),
    onData: (fn: (id: string, data: string) => void) => on('conn:data', fn),
    onState: (fn: (id: string, state: any, msg?: string) => void) => on('conn:state', fn),
  },
  prompts: {
    onHostKey: (fn: (reqId: string, p: any) => void) => on('prompt:hostKey', fn),
    onAuth: (fn: (reqId: string, p: any) => void) => on('prompt:auth', fn),
    reply: (reqId: string, value: unknown) => ipcRenderer.send('prompt:reply', reqId, value),
  },
  serial: { list: invoke('serial:list') },
  tunnels: {
    list: invoke('tunnels:list'),
    start: invoke('tunnels:start'),
    stop: invoke('tunnels:stop'),
    add: invoke('tunnels:add'),
    onChanged: (fn: (list: any[]) => void) => on('tunnels:changed', fn),
  },
  sftp: {
    home: invoke('sftp:home'),
    list: invoke('sftp:list'),
    mkdir: invoke('sftp:mkdir'),
    rename: invoke('sftp:rename'),
    chmod: invoke('sftp:chmod'),
    delete: invoke('sftp:delete'),
    download: invoke('sftp:download'),
    upload: invoke('sftp:upload'),
    readText: invoke('sftp:readText'),
    writeText: invoke('sftp:writeText'),
    onProgress: (fn: (id: string, p: any) => void) => on('sftp:progress', fn),
  },
  monitor: { stats: invoke('monitor:stats') },
  servers: {
    list: invoke('servers:list'),
    save: invoke('servers:save'),
    start: invoke('servers:start'),
    stop: invoke('servers:stop'),
    clearLogs: invoke('servers:clearLogs'),
    onStatus: (fn: (status: any[]) => void) => on('servers:status', fn),
    onLog: (fn: (entry: any) => void) => on('servers:log', fn),
  },
  pickDir: invoke('dialog:pickDir'),
  openPath: invoke('shell:openPath'),
  pickFile: invoke('dialog:pickFile'),
  openExternal: invoke('shell:openExternal'),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld('nexus', api);

export type NexusApi = typeof api;
