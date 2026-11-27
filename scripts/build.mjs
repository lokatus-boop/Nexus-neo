// Empaqueta main, preload y renderer con esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { writeInstallerLicense } from './legal.mjs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
mkdirSync('dist/renderer', { recursive: true });

// noVNC (lib CJS) usa un await de nivel superior para detectar H.264 por WebCodecs.
// Lo convertimos en una asignación asíncrona para poder empaquetarlo como IIFE.
const novncTla = {
  name: 'novnc-tla',
  setup(b) {
    b.onLoad({ filter: /@novnc[\\/]novnc[\\/]lib[\\/]util[\\/]browser\.js$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      const needle = 'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();';
      if (!src.includes(needle)) return { contents: src, loader: 'js' };
      const fixed = src.replace(
        needle,
        'exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = false; _checkWebCodecsH264DecodeSupport().then(function (v) { exports.supportsWebCodecsH264Decode = supportsWebCodecsH264Decode = v; });',
      );
      return { contents: fixed, loader: 'js' };
    });
  },
};

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info' };
const configs = [
  {
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'ssh2', 'node-pty', 'serialport', 'cpu-features'],
  },
  {
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: ['src/renderer/app.ts'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: ['src/renderer/vnc.ts'],
    outfile: 'dist/renderer/vnc.js',
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    plugins: [novncTla],
  },
  {
    ...common,
    entryPoints: ['src/renderer/rdp.ts'],
    outfile: 'dist/renderer/rdp.js',
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    // El cliente IronRDP lleva el WebAssembly incrustado (~5 MB); no tiene sentido el mapa de fuentes.
    sourcemap: false,
  },
];

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/vnc.html', 'dist/renderer/vnc.html');
cpSync('src/renderer/rdp.html', 'dist/renderer/rdp.html');
// Logotipo para la interfaz e icono de ventana (los instaladores usan build/icon.ico y build/icons/).
cpSync('build/icon.svg', 'dist/renderer/logo.svg');
cpSync('build/icons/256x256.png', 'dist/icon.png');
writeInstallerLicense();
if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
