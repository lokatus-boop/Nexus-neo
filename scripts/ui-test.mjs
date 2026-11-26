import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({
  entryPoints: ['test/ui-smoke.ts'], outfile: '.test-build/ui-smoke.js', bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['playwright', 'ssh2', 'electron', 'cpu-features'], logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['.test-build/ui-smoke.js'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
