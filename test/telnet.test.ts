import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelnetCodec, IAC, DO, WILL, WONT, DONT, SB, SE, OPT_NAWS, OPT_TTYPE, OPT_ECHO } from '../src/main/protocols/telnet-codec';

test('separa datos de comandos IAC', () => {
  const c = new TelnetCodec();
  const r = c.decode(Buffer.from([0x68, 0x6f, IAC, WILL, OPT_ECHO, 0x6c, 0x61]));
  assert.equal(r.data.toString(), 'hola');
  assert.deepEqual([...r.reply], [IAC, DO, OPT_ECHO]);
});

test('responde a DO NAWS con el tamaño de ventana', () => {
  const c = new TelnetCodec();
  c.cols = 120;
  c.rows = 40;
  const r = c.decode(Buffer.from([IAC, DO, OPT_NAWS]));
  assert.deepEqual([...r.reply], [IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE]);
  assert.deepEqual([...c.resize(80, 24)], [IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
});

test('envía el tipo de terminal cuando se pide', () => {
  const c = new TelnetCodec('xterm');
  const r1 = c.decode(Buffer.from([IAC, DO, OPT_TTYPE]));
  assert.deepEqual([...r1.reply], [IAC, WILL, OPT_TTYPE]);
  const r2 = c.decode(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE]));
  assert.deepEqual([...r2.reply], [IAC, SB, OPT_TTYPE, 0, ...Buffer.from('xterm'), IAC, SE]);
});

test('rechaza opciones desconocidas', () => {
  const c = new TelnetCodec();
  assert.deepEqual([...c.decode(Buffer.from([IAC, DO, 99])).reply], [IAC, WONT, 99]);
  assert.deepEqual([...c.decode(Buffer.from([IAC, WILL, 99])).reply], [IAC, DONT, 99]);
});

test('procesa comandos partidos entre paquetes y escapa IAC', () => {
  const c = new TelnetCodec();
  const a = c.decode(Buffer.from([0x41, IAC]));
  const b = c.decode(Buffer.from([IAC, 0x42]));
  assert.equal(Buffer.concat([a.data, b.data]).toString('latin1'), 'A\xffB');
  assert.deepEqual([...c.encode(Buffer.from([1, IAC, 2]))], [1, IAC, IAC, 2]);
});
