# Cambios

## 0.3.0

- **Tres servidores integrados nuevos** en el panel de servidores (`Ctrl+Mayús+E`):
  - **SFTP / SCP**: servidor SSH sólo de archivos sobre la carpeta raíz, con usuario y contraseña (en la bóveda)
    y/o claves públicas autorizadas. Admite SFTP, el `scp` moderno, el clásico (`scp -O`, también recursivo y
    con `-p`) y la copia por SCP de los equipos de red. Sin shell ni reenvíos, modo de sólo lectura opcional y
    clave de host ed25519 propia con su huella en el registro.
  - **HTTPS**: el servidor de archivos HTTP con TLS. Usa tu certificado PEM o genera uno autofirmado (ECDSA
    P-256) válido para el nombre del equipo y todas sus IP, que se reutiliza entre arranques.
  - **DHCP**: rango de direcciones, máscara, puerta de enlace, DNS, dominio, duración de la concesión, reservas
    por MAC y opciones 66/67/150 para teléfonos IP, PXE y ZTP. Tabla de concesiones en vivo, concesiones
    guardadas entre reinicios y detección de IP en conflicto (DHCPDECLINE).
- Las configuraciones guardadas de versiones anteriores reciben los servidores nuevos automáticamente.

## 0.2.1

- **Reenvío X11 arreglado en Linux**: ya no hace falta un servidor X propio; se usa el de la sesión gráfica
  (Xorg o XWayland). Se toma el `DISPLAY` del sistema o se detecta en `/tmp/.X11-unix`, y la cookie se lee de
  `$XAUTHORITY`/`~/.Xauthority` sin depender del programa `xauth`.
- **X11 activado por defecto** en las sesiones SSH nuevas y en la conexión rápida, con campo opcional
  «Pantalla X local» por sesión.
- **Cookie falsa hacia el servidor** (como OpenSSH): la cookie X real ya no se envía al remoto.
- Si el servidor rechaza el reenvío X11 el shell se abre igualmente con un aviso que explica qué revisar
  (`X11Forwarding`, `xauth`), y se avisa si no hay servidor X local (p. ej. VcXsrv sin arrancar en Windows).

## 0.2.0

- **Visor RDP integrado** en ventana propia (IronRDP en WebAssembly con una pasarela local): NLA/CredSSP y
  TLS con verificación del certificado (aviso si cambia), resolución dinámica, ajustar a la ventana,
  Ctrl+Alt+Supr, tecla Windows, portapapeles, pantalla completa, reconexión, credenciales en la bóveda y túnel
  SSH opcional. El cliente del sistema sigue disponible por sesión o en Ajustes.
- **Mosh**: nuevo tipo de sesión con cliente propio (sin instalar nada en el equipo local). Entra por SSH,
  arranca `mosh-server` y sigue por UDP cifrado (AES-128-OCB); aguanta cambios de red y cortes.
  `mosh://usuario@host` en la conexión rápida.
- **Sincronización cifrada entre equipos** de sesiones, macros, plantillas y temas a través de una carpeta
  compartida o SFTP. Un único archivo cifrado con tu frase (scrypt + AES-256-GCM), gana el cambio más reciente,
  los borrados se propagan y las contraseñas de la bóveda son opcionales.
- **Operaciones de red** (nuevo botón en la barra):
  - **Despliegue masivo** de órdenes con variables y directivas en muchos equipos por SSH o Telnet, con
    enable, paginadores, preguntas, detección de errores, subida previa de firmware por SCP o SFTP y
    resultados por equipo (registro, `resumen.csv` y `resumen.json`).
  - **Plantillas de configuración** con variables por equipo desde CSV, vista previa, generación de `.cfg` y
    aplicación con el despliegue.
  - **Respaldos de configuración** con 13 perfiles de fabricante, copia sólo si cambia, historial,
    comparación entre versiones y respaldo programado.
- **Temas personalizables**: editor con vista previa en vivo y aviso de contraste, importación de esquemas de
  Windows Terminal e iTerm2 y exportación a JSON.
- **Plugins** aislados en Web Workers con permisos (`terminal:read`, `terminal:write`, `sessions:read`):
  comandos en la paleta, salida del terminal, avisos, barra de estado, temas y almacenamiento propio. Plugin de
  ejemplo en `examples/plugins/`.
- **Documentación**: manual de usuario completo en `docs/manual.md` y guía de plugins en `docs/plugins.md`.

## 0.1.2

- **Icono nuevo** original: una «N» trazada como un grafo de nodos conectados con degradado turquesa-violeta y
  cursor de terminal. Fuente SVG en `build/icon.svg`, con variante simplificada para tamaños pequeños;
  `npm run icons` genera el `.ico` de Windows y los PNG de Linux. Se usa en instaladores, accesos directos,
  ventana, barra de tareas, ventana VNC y en la propia interfaz.
- **Acerca de** (botón ⓘ y paleta de comandos): versión, «Hecho por Luismi Sanz», licencia, enlace al
  repositorio y versiones de Electron/Chromium/Node.
- **Aviso legal**: el software se proporciona tal cual y se usa bajo la responsabilidad del usuario. Se pide
  aceptarlo en el primer arranque (con «Salir» si no se acepta), aparece en «Acerca de», en el README y en el
  instalador de Windows.
- Corregido: el icono de ventana no se incluía en los paquetes de Linux.

## 0.1.1

- **Permisos de claves SSH en Windows.** OpenSSH para Windows rechaza las claves privadas que otros
  usuarios pueden leer («WARNING: UNPROTECTED PRIVATE KEY FILE! … bad permissions»), algo habitual con
  las claves descargadas al Escritorio o a Descargas. Nexus Neo ahora:
  - corrige la ACL de las claves que genera (sólo tu usuario y SYSTEM, sin herencia);
  - avisa al elegir una clave con permisos demasiado abiertos en una sesión y ofrece **corregirlos** o
    **copiarla protegida a `~/.ssh`**;
  - permite **importar** claves desde el gestor de claves (copia a `~/.ssh`, genera la `.pub` y protege
    el archivo) y marca con un aviso las claves de `~/.ssh` con permisos incorrectos, con botón «Corregir»;
  - si la corrección falla, muestra el motivo y los comandos `icacls` para hacerlo a mano.
  - En Linux aplica lo mismo con `chmod 600`.
- Las conexiones SSH de Nexus Neo funcionan con esas claves aunque sus permisos estén abiertos.
- CI: al publicar una etiqueta `v*` se crea la release de GitHub con los instaladores de Windows y Linux.

## 0.1.0

- Primera versión.
