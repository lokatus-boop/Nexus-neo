import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMacro, encodeRecording, runMacro } from '../src/renderer/macro-engine';

test('interpreta escapes y pausas', () => {
  assert.deepEqual(parseMacro('ls -la\\n{sleep:250}exit\\n'), [
    { type: 'text', text: 'ls -la\r' },
    { type: 'sleep', ms: 250 },
    { type: 'text', text: 'exit\r' },
  ]);
  assert.deepEqual(parseMacro('a\\tb\\e\\x03{{x}}'), [{ type: 'text', text: 'a\tb\x1b\x03{x}' }]);
});

test('una llave sin directiva se trata como texto', () => {
  assert.deepEqual(parseMacro('echo {a,b}'), [{ type: 'text', text: 'echo {a,b}' }]);
});

test('la grabación codificada se reproduce idéntica', () => {
  const raw = 'cd /tmp\r\x1b[A\x03{x}\\fin\t';
  const steps = parseMacro(encodeRecording(raw));
  assert.equal(steps.map((s) => (s.type === 'text' ? s.text : '')).join(''), raw);
});

test('runMacro escribe los pasos en orden', async () => {
  const out: string[] = [];
  await runMacro(parseMacro('uno\\n{sleep:5}dos'), (d) => out.push(d));
  assert.deepEqual(out, ['uno\r', 'dos']);
});
