// Empaqueta main, preload y renderer con esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
mkdirSync('dist/renderer', { recursive: true });

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
];

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
