// Compila las pruebas con esbuild y las ejecuta con el runner nativo de Node.
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const filter = process.argv[2];
const files = readdirSync('test').filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)));
rmSync('.test-build', { recursive: true, force: true });
await build({
  entryPoints: files.map((f) => `test/${f}`),
  outdir: '.test-build',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['electron', 'ssh2', 'node-pty', 'serialport', 'cpu-features'],
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-reporter=spec', ...files.map((f) => `.test-build/${f.replace(/\.ts$/, '.js')}`)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
