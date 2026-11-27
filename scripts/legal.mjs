// Genera build/licencia.txt (aviso legal + licencia MIT) que el instalador de Windows pide aceptar.
// Se ejecuta en cada build para que el texto coincida siempre con src/shared/legal.ts.
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function writeInstallerLicense() {
  const out = '.test-build/legal.cjs';
  buildSync({ entryPoints: ['src/shared/legal.ts'], outfile: out, format: 'cjs', platform: 'node', logLevel: 'warning' });
  const { AUTHOR, DISCLAIMER, DISCLAIMER_TITLE } = createRequire(import.meta.url)(`../${out}`);
  const lines = [
    `NEXUS NEO — ${DISCLAIMER_TITLE.toUpperCase()}`,
    `Hecho por ${AUTHOR}`,
    '',
    ...DISCLAIMER.flatMap((p) => [p, '']),
    'Al continuar con la instalación declaras que has leído este aviso y aceptas usar Nexus Neo bajo tu propia responsabilidad.',
    '',
    '-'.repeat(64),
    '',
    readFileSync('LICENSE', 'utf8').trimEnd(),
    '',
  ];
  // BOM + CRLF para que el instalador NSIS lo muestre bien en Windows.
  writeFileSync('build/licencia.txt', '﻿' + lines.join('\r\n').replace(/\r?\n/g, '\r\n'));
}
