// Plugin de ejemplo para Nexus Neo. Se ejecuta en un Web Worker aislado: no hay DOM, ni Node,
// ni red. Todo se hace a través del objeto global «nexus» (ver docs/plugins.md).

let errores = 0;

async function actualizarEstado() {
  await nexus.ui.setStatus(errores ? `⚠ ${errores} error(es) de CLI` : '');
}

// 1. Comandos en la paleta (Ctrl+Mayús+K).
nexus.commands.register('insertar-fecha', 'Insertar fecha y hora', async () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  await nexus.terminal.send(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
});

nexus.commands.register('marca-comentario', 'Insertar comentario con marca de tiempo', async () => {
  const autor = (await nexus.storage.get('autor')) || (await nexus.ui.prompt('Tu nombre para los comentarios', 'Nombre'));
  if (!autor) return;
  await nexus.storage.set('autor', autor);
  await nexus.terminal.send(`! ${new Date().toISOString()} ${autor}: `);
});

nexus.commands.register('reiniciar-errores', 'Poner a cero el contador de errores', async () => {
  errores = 0;
  await actualizarEstado();
  await nexus.ui.notify('Contador de errores a cero', 'ok');
});

// 2. Reaccionar a la salida de los terminales.
nexus.terminal.onOutput(({ title, data }) => {
  const n = (data.match(/% ?Invalid input|% ?Incomplete command|% ?Ambiguous command/g) || []).length;
  if (!n) return;
  errores += n;
  void actualizarEstado();
  void nexus.ui.notify(`${title}: el equipo ha rechazado una orden`, 'error');
});

// 3. Un tema propio (aparece en Ajustes y en la paleta como «Ámbar retro»).
nexus.themes.register({
  id: 'ambar-retro',
  name: 'Ámbar retro',
  term: {
    background: '#1a1200', foreground: '#ffb000', cursor: '#ffcc00',
    black: '#1a1200', red: '#ff6b35', green: '#ffb000', yellow: '#ffd166', blue: '#e09f3e', magenta: '#ff9f1c', cyan: '#ffbf69', white: '#ffe8b0',
    brightBlack: '#6b4e00', brightRed: '#ff8c5a', brightGreen: '#ffc533', brightYellow: '#ffe08a', brightBlue: '#f0b65e', brightMagenta: '#ffb84d', brightCyan: '#ffd699', brightWhite: '#fff5d6',
  },
});
