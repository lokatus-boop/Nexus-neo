# Nexus Neo

Cliente de acceso remoto **multiplataforma (Windows y Linux)** que reúne en una sola ventana con pestañas
SSH, SFTP, Telnet, puerto serie, túneles SSH, reenvío X11, terminal local, multi-ejecución, macros y una
bóveda de credenciales cifrada. Es un proyecto original (nombre, diseño y código propios), pensado como
alternativa moderna y abierta a las «navajas suizas» de terminal para administradores de sistemas.

![Sesión SSH con explorador SFTP](docs/screenshots/03-ssh-sftp.png)

## Funcionalidades

### Disponibles en la versión 0.1 (MVP)

| Área | Qué incluye |
| --- | --- |
| **Sesiones en pestañas** | Pestañas ilimitadas, reordenables, renombrables, con color por sesión, estado de conexión, duplicar, reconectar (tecla `R` tras desconexión) y guardar la salida en un archivo. |
| **Gestor de sesiones** | Árbol por carpetas, filtro instantáneo, editar/duplicar/eliminar, exportar e importar (formato JSON propio, sin contraseñas) e **importación de `~/.ssh/config`** (incluye `ProxyJump`, `ForwardX11` y reenvíos). |
| **SSH** | Contraseña, clave privada (con frase de paso), agente SSH (OpenSSH/Pageant en Windows), keyboard-interactive/2FA, keepalive, `TERM` configurable, verificación de huella del host (TOFU) con **aviso de posible ataque MITM** si la clave cambia. |
| **Bastiones (ProxyJump)** | Saltos encadenados a través de otras sesiones guardadas. |
| **Explorador SFTP** | Panel lateral redimensionable junto al terminal: navegar, subir/descargar (también carpetas completas y arrastrar y soltar desde el escritorio), barra de progreso, crear carpetas, renombrar, borrar, `chmod`, copiar ruta y **editar archivos remotos en el momento**. |
| **Túneles SSH** | Local (`-L`), remoto (`-R`) y dinámico SOCKS5 (`-D`). Se definen por sesión con arranque automático o se crean al vuelo; gestor con estado y nº de conexiones activas. |
| **Reenvío X11** | Reenvía aplicaciones gráficas al servidor X local (Linux de forma nativa usando la cookie de `xauth`; en Windows con un servidor X como VcXsrv o X410). |
| **Terminal local** | Detección automática de shells: PowerShell 7, Windows PowerShell, CMD, WSL y Git Bash en Windows; los de `/etc/shells` en Linux. |
| **Telnet** | Con negociación de eco, SGA, tamaño de ventana (NAWS) y tipo de terminal. |
| **Puerto serie** | Lista de puertos detectados, baudios, bits de datos/parada, paridad y eco local. |
| **RDP / VNC** | Se abren con el cliente del sistema (`mstsc`, `xfreerdp`, `vncviewer` o el que configures). |
| **Multi-ejecución** | Escribe a la vez en todas las pestañas marcadas (casilla en cada pestaña). |
| **Macros** | Editor de macros con escapes (`\n`, `\t`, `\e`, `\xHH`) y pausas `{sleep:ms}`, **grabación** de lo que tecleas, ejecución en una pestaña o en todas las de multi-ejecución, y macro de arranque por sesión. |
| **Bóveda de credenciales** | Contraseña maestra, scrypt + AES-256-GCM, bloqueo manual y automático por inactividad, cambio de contraseña maestra. Los secretos nunca se guardan en claro. |
| **Monitor remoto** | Barra inferior con carga de CPU, RAM, disco y tiempo encendido del servidor SSH activo. |
| **Personalización** | 5 temas (oscuros y claro), tipografía, tamaño (zoom con `Ctrl` `+`/`-`), cursor, historial, copiar al seleccionar, pegar con clic derecho. |
| **Productividad** | Conexión rápida (`usuario@host:puerto`, `telnet://`, `rdp://`, `vnc://`), paleta de comandos `Ctrl+Mayús+K`, búsqueda en el terminal, enlaces clicables. |
| **Modo portable** | Crea un archivo llamado `portable` junto al ejecutable y los datos se guardan en `./data`. |

### Mejoras frente a las herramientas clásicas

- **Nativo en Linux**, no sólo Windows.
- Importación directa de `~/.ssh/config`, incluidos bastiones y túneles.
- Edición de archivos remotos desde el panel SFTP sin herramientas externas.
- Grabación de macros y pausas temporizadas.
- Paleta de comandos y conexión rápida tipo URI.
- Advertencia explícita ante cambios de clave de host.
- Bóveda con cifrado autenticado (detecta manipulaciones del archivo) y autobloqueo.
- Código abierto, auditable y extensible.

## Hoja de ruta

Funciones previstas para alcanzar y superar el conjunto completo de una suite profesional:

- [ ] **Visor RDP y VNC integrados** en pestaña (VNC vía noVNC/RFB en el propio proceso; RDP vía FreeRDP embebido).
- [ ] **Servidor X11 integrado en Windows** (empaquetar VcXsrv/Xming opcional) para no depender de software externo.
- [ ] **Mosh** (integrando el cliente `mosh-client` y el arranque vía SSH).
- [ ] **rlogin, FTP/FTPS, XDMCP** y sesiones de explorador de archivos (S3, WebDAV).
- [ ] **Terminales divididos** (2 o 4 paneles por pestaña) y desacoplar pestañas en ventanas.
- [ ] **Sistema de plugins** (API para nuevos protocolos, paneles y acciones de la paleta).
- [ ] **Generador de claves SSH** (ed25519/RSA) y gestor de `authorized_keys`.
- [ ] SFTP que **sigue la carpeta del terminal**, cola de transferencias en paralelo y reanudación.
- [ ] **Registro de sesiones** automático a archivo y reproducción.
- [ ] **Herramientas de red**: escáner de puertos, servidores TFTP/HTTP/FTP de un clic, ping/traceroute gráficos.
- [ ] **Importación de sesiones** desde otras herramientas (archivos de exportación de clientes populares, PuTTY desde el registro de Windows).
- [ ] Integración con el almacén de credenciales del sistema (Windows Credential Manager / libsecret) y llaves FIDO2.
- [ ] Sincronización cifrada de sesiones entre equipos.
- [ ] Personalizador de marca para despliegues corporativos (logo, ajustes predefinidos).
- [ ] Firmado de código y actualizaciones automáticas.
- [ ] Traducción al inglés (i18n).

## Instalación y desarrollo

Requisitos: Node.js 20 o superior.

```bash
npm install
npm run dev          # compila y abre la app
npm test             # pruebas unitarias e integración (SSH/SFTP/túneles contra un servidor de pruebas)
npm run test:ui      # prueba de humo de la interfaz con Playwright (en Linux sin pantalla: xvfb-run -a npm run test:ui)
npm run typecheck
```

Paquetes instalables:

```bash
npm run dist:linux   # AppImage y .deb en release/
npm run dist:win     # instalador NSIS y versión portable (ejecutar en Windows)
```

Los módulos nativos (`node-pty`, `serialport`) usan N-API, así que no hace falta recompilarlos para Electron.
El flujo de GitHub Actions compila y prueba en Linux y Windows y publica los paquetes como artefactos.

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Ctrl+Mayús+T` | Nueva terminal local |
| `Ctrl+Mayús+W` | Cerrar pestaña |
| `Ctrl+Tab` / `Ctrl+Mayús+Tab` | Pestaña siguiente / anterior |
| `Ctrl+Mayús+K` | Paleta de comandos e ir a sesión |
| `Ctrl+Mayús+M` | Activar/desactivar multi-ejecución |
| `Ctrl+Mayús+S` | Mostrar/ocultar SFTP |
| `Ctrl+Mayús+B` | Mostrar/ocultar el panel de sesiones |
| `Ctrl+Mayús+F` | Buscar en el terminal |
| `Ctrl+Mayús+C` / `Ctrl+Mayús+V` | Copiar / pegar |
| `Ctrl` `+` / `-` / `0` | Zoom del texto |

## Arquitectura

```
src/
  main/            Proceso principal de Electron (Node.js)
    protocols/     ssh (ssh2), local (node-pty), telnet, serial (serialport), túneles, SOCKS5, clientes externos
    vault.ts       Bóveda cifrada (scrypt + AES-256-GCM)
    store.ts       Sesiones, macros, ajustes y huellas conocidas (JSON)
    sftp-ops.ts    Operaciones SFTP de alto nivel
    importers.ts   Importación de ~/.ssh/config y exportaciones propias
  preload/         Puente IPC mínimo (contextIsolation + sandbox)
  renderer/        Interfaz (TypeScript sin framework + xterm.js)
  shared/          Tipos compartidos
test/              Pruebas (node:test) y servidor SSH/SFTP de pruebas
```

Seguridad: la interfaz se ejecuta con `contextIsolation`, `sandbox` y sin `nodeIntegration`, con CSP estricta.
Las contraseñas sólo viajan al proceso principal y sólo se escriben en disco cifradas en la bóveda.

## Licencia

MIT
