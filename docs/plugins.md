# Cómo escribir un plugin para Nexus Neo

Un plugin es una carpeta con dos archivos: `manifest.json`, que lo describe, y un archivo JavaScript con su
código. Nexus Neo ejecuta cada plugin en su propio **Web Worker aislado**: no tiene acceso a Node.js, al
sistema de archivos, a la red, a la bóveda ni a la página. Todo lo que puede hacer pasa por el objeto global
`nexus`.

En `examples/plugins/marcas-de-tiempo` tienes un ejemplo completo.

## Estructura

```
mi-plugin/
  manifest.json
  main.js
```

El nombre de la carpeta debe coincidir con el `id` del manifiesto.

## manifest.json

```json
{
  "id": "mi-plugin",
  "name": "Mi plugin",
  "version": "1.0.0",
  "description": "Qué hace, en una o dos frases.",
  "author": "Tu nombre",
  "main": "main.js",
  "permissions": ["terminal:read", "terminal:write"]
}
```

| Campo | Obligatorio | Reglas |
| --- | --- | --- |
| `id` | Sí | De 2 a 60 caracteres: minúsculas, números, `.`, `-` o `_`. Empieza por letra o número. |
| `name` | Sí | Nombre visible (máx. 60 caracteres). |
| `version` | Sí | `1.0`, `1.0.0` o `1.0.0-beta.1`. |
| `description` | No | Se muestra en la lista de plugins. |
| `author` | No | Se muestra al activarlo. |
| `main` | No | Archivo `.js` dentro de la carpeta (por defecto `main.js`). Máximo 2 MB. |
| `permissions` | No | Lista de permisos (ver abajo). |

### Permisos

| Permiso | Da acceso a |
| --- | --- |
| `terminal:read` | `nexus.terminal.onOutput()` y `nexus.terminal.active()`. |
| `terminal:write` | `nexus.terminal.send()`. |
| `sessions:read` | `nexus.sessions.list()`. |

El usuario ve los permisos al activar el plugin. Si una versión nueva pide más permisos, el plugin no se
ejecuta hasta que el usuario los acepte. Llamar a una función sin su permiso rechaza la promesa con un error
que lo explica.

## La API `nexus`

Todas las funciones devuelven una **promesa**.

### Información del plugin

```js
nexus.plugin.id;       // "mi-plugin"
nexus.plugin.name;     // "Mi plugin"
nexus.plugin.version;  // "1.0.0"
```

### Comandos de la paleta

```js
nexus.commands.register('saludar', 'Saludar en el terminal', async () => {
  await nexus.terminal.send('echo hola\r');
});
```

`register(id, etiqueta, función)` añade una entrada a la paleta (`Ctrl+Mayús+K`) con la etiqueta indicada. La
función se ejecuta al elegirla. Registrar otra vez el mismo `id` cambia la etiqueta y la función. Máximo 50
comandos por plugin.

### Terminal

```js
// Escribe en el terminal activo como si el usuario tecleara (permiso terminal:write).
// Usa \r para pulsar Intro.
await nexus.terminal.send('show version\r');

// Pestaña activa: { connId, title } o null (permiso terminal:read).
const tab = await nexus.terminal.active();

// Salida de todos los terminales (permiso terminal:read).
nexus.terminal.onOutput(({ connId, title, data }) => {
  if (/% Invalid input/.test(data)) nexus.ui.notify(`${title}: orden rechazada`, 'error');
});
```

La salida llega agrupada (cada 50 ms como mucho) y en bruto, con los códigos de color del terminal. Si
necesitas texto limpio, quítalos con una expresión regular como `/\x1b\[[0-9;?]*[ -\/]*[@-~]/g`.

### Interfaz

```js
await nexus.ui.notify('Hecho', 'ok');                  // 'info' (por defecto), 'ok' o 'error'
const nombre = await nexus.ui.prompt('Título', 'Etiqueta del campo'); // texto o null si se cancela
await nexus.ui.setStatus('3 alertas');                  // texto en la barra de estado ('' lo borra)
```

Los avisos llevan delante el nombre del plugin. El texto de estado se limita a 60 caracteres.

### Temas

```js
await nexus.themes.register({
  id: 'mi-tema',
  name: 'Mi tema',
  term: {
    background: '#101418', foreground: '#d0d8e0', cursor: '#40c0a0',
    black: '#101418', red: '#e06060', green: '#60c080', yellow: '#e0c060',
    blue: '#6090e0', magenta: '#c070d0', cyan: '#40c0c0', white: '#d0d8e0',
    brightBlack: '#506070', brightRed: '#ff8080', brightGreen: '#80e0a0', brightYellow: '#ffe080',
    brightBlue: '#80b0ff', brightMagenta: '#e090f0', brightCyan: '#60e0e0', brightWhite: '#ffffff',
  },
  // ui es opcional: si no se indica, se deduce de los colores del terminal.
  ui: { accent: '#40c0a0' },
});
```

El tema aparece en Ajustes, en el editor de temas y en la paleta mientras el plugin esté activo. Su `id` final
es `plugin-<id del plugin>-<id del tema>`. Colores admitidos: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` y
`rgba()`. Claves de `ui`: `bg`, `panel`, `panel2`, `border`, `text`, `muted`, `accent`, `accent2`, `danger` y
`warn`.

### Sesiones

```js
// Permiso sessions:read. Nunca incluye contraseñas ni claves.
const lista = await nexus.sessions.list(); // [{ name, kind, host, folder }, …]
```

### Almacenamiento propio

```js
await nexus.storage.set('contador', 5);       // cualquier valor que se pueda pasar a JSON
const n = await nexus.storage.get('contador'); // null si no existe
await nexus.storage.set('contador', null);    // lo borra
```

Cada plugin tiene su propio almacenamiento (máx. 1 MB), que se conserva al actualizarlo y se borra al quitarlo.

### Registro

```js
nexus.log('algo ha pasado', valor);
```

Escribe un aviso en la consola de las herramientas de desarrollo de la ventana principal, con el id del plugin
delante. Útil al ejecutar Nexus Neo desde el código (`npm run dev`).

## Qué no puede hacer un plugin

- Acceder a la red (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` y `importScripts` no existen dentro
  del worker y la política de seguridad bloquea cualquier conexión).
- Leer o escribir archivos, ejecutar programas o usar módulos de Node.js.
- Tocar la página: no hay `document` ni `window`.
- Leer la bóveda, contraseñas o claves.

Si tu idea necesita algo de esto, abre una propuesta en el repositorio para ampliar la API de forma segura.

## Probar el plugin

1. Copia la carpeta a la carpeta de plugins (Ajustes → Plugins → **Abrir carpeta de plugins**) o usa
   **Instalar desde carpeta…**.
2. Pulsa **Activar** y acepta los permisos.
3. Tras cambiar el código, pulsa **Recargar**.
4. Los errores (de sintaxis o al ejecutar) aparecen en rojo en la ficha del plugin.

## Ejemplo completo

```js
// Cuenta las líneas «% Invalid input» y muestra el total en la barra de estado.
let errores = 0;

nexus.terminal.onOutput(({ data }) => {
  const n = (data.match(/% ?Invalid input/g) || []).length;
  if (!n) return;
  errores += n;
  nexus.ui.setStatus(`⚠ ${errores} errores`);
});

nexus.commands.register('cero', 'Poner a cero el contador de errores', () => {
  errores = 0;
  return nexus.ui.setStatus('');
});
```

```json
{ "id": "contador-errores", "name": "Contador de errores", "version": "1.0.0", "permissions": ["terminal:read"] }
```
