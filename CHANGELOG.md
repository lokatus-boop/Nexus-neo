# Cambios

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
