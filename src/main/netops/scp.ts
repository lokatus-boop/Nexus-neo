// Subida de archivos por SCP (protocolo «scp -t»), que admiten muchos switches y routers
// que no tienen SFTP (Cisco IOS con «ip scp server enable», Aruba, HPE, Juniper…).
import { createReadStream, promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { Client, ClientChannel } from 'ssh2';

function readAck(ch: ClientChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      ch.off('data', onData);
      if (d[0] === 0) return resolve();
      reject(new Error(`SCP: ${d.subarray(1).toString('utf8').trim() || 'el servidor rechazó la transferencia'}`));
    };
    ch.on('data', onData);
    ch.once('close', () => reject(new Error('SCP: el servidor cerró la conexión.')));
  });
}

/** Sube un archivo local a `remotePath` (archivo o carpeta destino). */
export async function scpUpload(client: Client, localPath: string, remotePath: string, progress?: (sent: number, total: number) => void): Promise<void> {
  const st = await fs.stat(localPath);
  const ch = await new Promise<ClientChannel>((resolve, reject) =>
    client.exec(`scp -t ${/^[\w@%+=:,./-]+$/.test(remotePath) ? remotePath : `'${remotePath.replace(/'/g, `'\\''`)}'`}`, (err, c) => (err ? reject(err) : resolve(c))));
  try {
    await readAck(ch);
    ch.write(`C0644 ${st.size} ${basename(localPath).replace(/\n/g, '_')}\n`);
    await readAck(ch);
    let sent = 0;
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(localPath, { highWaterMark: 32 * 1024 });
      rs.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        progress?.(sent, st.size);
        if (!ch.write(chunk)) {
          rs.pause();
          ch.once('drain', () => rs.resume());
        }
      });
      rs.once('end', () => resolve());
      rs.once('error', reject);
    });
    ch.write(Buffer.from([0]));
    await readAck(ch);
  } finally {
    ch.end();
  }
}
