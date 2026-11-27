import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server, AddressInfo, Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  RDCLEANPATH_VERSION, encodePdu, decodePdu, pduLength, parseX224Confirm, tpktLength, NEGOTIATION_ERROR,
} from '../src/main/rdp/rdcleanpath';
import { RdpGateway, certFingerprint } from '../src/main/rdp/gateway';
import { TEST_CERT, TEST_KEY } from './helpers/test-cert';

// Petición X.224 típica de un cliente: TPKT + CR + RDP_NEG_REQ (TLS|CredSSP).
const X224_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex');
const confirm = (protocol: number, failure = false) =>
  Buffer.from(`030000130ed000001234000${failure ? '3' : '2'}000800${protocol.toString(16).padStart(2, '0')}000000`, 'hex');

test('RDCleanPath: codifica y decodifica una petición y una respuesta', () => {
  const req = encodePdu({ version: RDCLEANPATH_VERSION, destination: 'srv:3389', proxyAuth: 'vale', x224: X224_REQUEST });
  assert.equal(pduLength(req), req.length);
  assert.equal(pduLength(req.subarray(0, 1)), null);
  const back = decodePdu(req);
  assert.equal(back.version, 3390);
  assert.equal(back.destination, 'srv:3389');
  assert.equal(back.proxyAuth, 'vale');
  assert.deepEqual(back.x224, X224_REQUEST);

  // Cadena larga (longitud DER en forma larga) y error.
  const big = Buffer.alloc(70000, 7);
  const resp = decodePdu(encodePdu({ version: RDCLEANPATH_VERSION, x224: confirm(1), serverCertChain: [big, Buffer.from([1, 2])], serverAddr: '10.0.0.5' }));
  assert.equal(resp.serverCertChain?.length, 2);
  assert.equal(resp.serverCertChain?.[0].length, 70000);
  assert.equal(resp.serverAddr, '10.0.0.5');
  const err = decodePdu(encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode: 1, httpStatusCode: 401, tlsAlertCode: 40 } }));
  assert.deepEqual(err.error, { errorCode: 1, httpStatusCode: 401, tlsAlertCode: 40 });
  // Codificación DER exacta de la PDU de error más simple.
  assert.equal(encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode: 1 } }).toString('hex'), '300fa00402020d3ea1073005a003020101');
});

test('X.224: interpreta la confirmación, el rechazo y la seguridad clásica', () => {
  assert.equal(tpktLength(confirm(2)), 19);
  assert.deepEqual(parseX224Confirm(confirm(2)), { kind: 'ok', protocol: 2 });
  assert.deepEqual(parseX224Confirm(confirm(5, true)), { kind: 'failure', code: 5 });
  assert.deepEqual(parseX224Confirm(Buffer.from('0300000b06d00000123400', 'hex')), { kind: 'legacy' });
  assert.throws(() => tpktLength(Buffer.from('16030100', 'hex')));
});

// --- Servidor RDP falso: confirma X.224 con TLS y después hace eco en mayúsculas. ---
let fake: Server;
let fakePort: number;
let negotiateFailure = false;
const received: Buffer[] = [];

before(async () => {
  fake = createServer((sock: Socket) => {
    sock.once('data', (d: Buffer) => {
      received.push(d);
      if (negotiateFailure) {
        sock.end(confirm(2, true));
        return;
      }
      sock.write(confirm(1));
      const tls = new TLSSocket(sock, { isServer: true, secureContext: createSecureContext({ cert: TEST_CERT, key: TEST_KEY }) });
      tls.on('data', (x: Buffer) => tls.write(x.toString('utf8').toUpperCase()));
      tls.on('error', () => undefined);
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakePort = (fake.address() as AddressInfo).port;
});

after(() => fake.close());

function talk(url: string, first: Buffer, then?: string): Promise<{ pdu: ReturnType<typeof decodePdu>; echo?: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let pdu: ReturnType<typeof decodePdu> | null = null;
    let echo = '';
    ws.on('open', () => ws.send(first));
    ws.on('message', (m: Buffer) => {
      if (!pdu) {
        pdu = decodePdu(m);
        if (then && !pdu.error) ws.send(Buffer.from(then));
        else if (!then) ws.close();
        return;
      }
      echo += m.toString('utf8');
      if (then && echo.length >= then.length) {
        ws.close();
        resolve({ pdu, echo, closed: false });
      }
    });
    ws.on('close', () => (pdu ? resolve({ pdu, echo: echo || undefined, closed: true }) : reject(new Error('cerrado sin respuesta'))));
    ws.on('error', reject);
  });
}

test('Pasarela: negocia TLS, pide confirmar la huella y reenvía los datos descifrados', async () => {
  const gw = new RdpGateway();
  await gw.start();
  const seen: string[] = [];
  const { url, token } = gw.issue({
    host: '127.0.0.1',
    port: fakePort,
    verifyCertificate: async (c) => {
      seen.push(c.fingerprint);
      assert.equal(c.subject, 'rdp-pruebas');
      return true;
    },
  });
  // El destino que manda el cliente se ignora: manda el vale.
  const req = encodePdu({ version: RDCLEANPATH_VERSION, destination: 'otro-servidor:3389', proxyAuth: token, x224: X224_REQUEST });
  const r = await talk(url, req, 'hola rdp');
  assert.equal(r.pdu.error, undefined);
  assert.deepEqual(r.pdu.x224, confirm(1));
  assert.equal(r.pdu.serverAddr, '127.0.0.1');
  const expected = certFingerprint(Buffer.from(new X509Certificate(TEST_CERT).raw));
  assert.equal(certFingerprint(r.pdu.serverCertChain![0]), expected);
  assert.deepEqual(seen, [expected]);
  assert.equal(r.echo, 'HOLA RDP');
  assert.deepEqual(received.at(-1), X224_REQUEST);
  await gw.stop();
});

test('Pasarela: rechaza vales desconocidos, certificados no aceptados y propaga el rechazo de negociación', async () => {
  const gw = new RdpGateway();
  await gw.start();
  const { url, token } = gw.issue({ host: '127.0.0.1', port: fakePort, verifyCertificate: async () => false });
  const bad = await talk(url, encodePdu({ version: RDCLEANPATH_VERSION, destination: 'x', proxyAuth: 'falso', x224: X224_REQUEST }));
  assert.equal(bad.pdu.error?.httpStatusCode, 401);

  const refused = await talk(url, encodePdu({ version: RDCLEANPATH_VERSION, destination: 'x', proxyAuth: token, x224: X224_REQUEST }), 'nada');
  assert.equal(refused.pdu.error?.httpStatusCode, 403);
  assert.equal(refused.echo, undefined);

  negotiateFailure = true;
  const neg = await talk(url, encodePdu({ version: RDCLEANPATH_VERSION, destination: 'x', proxyAuth: token, x224: X224_REQUEST }));
  negotiateFailure = false;
  assert.equal(neg.pdu.error?.errorCode, NEGOTIATION_ERROR);
  assert.deepEqual(parseX224Confirm(neg.pdu.x224!), { kind: 'failure', code: 2 });

  gw.revoke(token);
  const revoked = await talk(url, encodePdu({ version: RDCLEANPATH_VERSION, destination: 'x', proxyAuth: token, x224: X224_REQUEST }));
  assert.equal(revoked.pdu.error?.httpStatusCode, 401);
  await gw.stop();
});
