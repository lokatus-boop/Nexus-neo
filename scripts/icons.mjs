// Genera los iconos de la app a partir de build/icon.svg (y build/icon-small.svg para ≤32 px).
// Uso: npm run icons   (requiere el Chromium de Playwright)
// Salida: build/icon.png (512), build/icons/NxN.png (Linux), build/icon.ico (Windows)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const big = readFileSync('build/icon.svg', 'utf8');
const small = readFileSync('build/icon-small.svg', 'utf8');
const LINUX = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO = [16, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch();
const page = await browser.newPage();
const png = {};
for (const s of [...new Set([...LINUX, ...ICO])]) {
  const svg = (s <= 32 ? small : big).replace('<svg ', `<svg style="display:block;width:${s}px;height:${s}px" `);
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  png[s] = await page.screenshot({ omitBackground: true });
}
await browser.close();

mkdirSync('build/icons', { recursive: true });
for (const s of LINUX) writeFileSync(`build/icons/${s}x${s}.png`, png[s]);
writeFileSync('build/icon.png', png[512]);

// ICO con entradas PNG (válido desde Windows Vista).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(ICO.length, 4);
const entries = [];
let offset = 6 + 16 * ICO.length;
for (const s of ICO) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); // planos
  e.writeUInt16LE(32, 6); // bits por píxel
  e.writeUInt32LE(png[s].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png[s].length;
  entries.push(e);
}
writeFileSync('build/icon.ico', Buffer.concat([header, ...entries, ...ICO.map((s) => png[s])]));
console.log('Iconos generados en build/');
