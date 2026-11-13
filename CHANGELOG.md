# Registro de cambios

Todos los cambios relevantes de Valet Deck se anotan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado
[SemVer](https://semver.org/lang/es/).

## [0.1.0] — 2026-11-13

Primera publicación pública con el nombre **Valet Deck**. Instala y gestiona Laravel Valet en
Linux desde una interfaz de escritorio, sin envolver el runtime de Valet ni exigir Flock.

### Añadido

- **Instalador guiado** para PHP 8.5 con PHP-FPM y las extensiones de Valet, Composer, nginx,
  Laravel Valet y, opcionalmente, Node.js 26 con nvm y MariaDB. Cada componente muestra su
  progreso y el primer arranque entra directo si ya está todo instalado.
- **Sitios** parkeados y enlazados, con búsqueda, HTTPS por sitio, apertura en el navegador y
  ficha de detalle: `.env`, base de datos, correo, colas, PHP/Node.js y registros.
- **Borrado de sitios** desde la página Sites. Un sitio enlazado se puede quitar dejando sus
  archivos; uno parkeado exige borrar su carpeta. El borrado destructivo pide escribir el
  nombre del sitio y se niega a tocar raíces, carpetas parkeadas completas o datos de Valet.
- **Creación de proyectos Laravel** con elección de versión, base de datos, correo y Node.js.
- **PHP**: versiones instalables e instaladas, versión que sirve Valet, aislamiento por sitio,
  repositorio por distribución y actualizaciones de parche.
- **Node.js**: versiones de nvm, alias por defecto y fijación por sitio con `.nvmrc`.
- **Bases de datos** MariaDB, MySQL, PostgreSQL y SQLite, con guías de instalación, creación de
  bases y usuarios, y un bloque `.env` copiable para cada motor.
- **Correo integrado**: un catcher SMTP propio que arranca con el panel, con bandejas, búsqueda,
  adjuntos y el bloque `MAIL_*` listo para Laravel.
- **Servicios y puertos**: estado real, journal, detección del proceso que ocupa 80/443 y cambio
  de puertos de Valet y Apache.
- **DNS** en modo seguro con `systemd-resolved`, modo Hosts o desactivado, con reparación desde
  Settings.
- **Settings → Programs and updates**: compara PHP, Composer, Laravel Valet y Node.js con la
  última versión, actualiza los paquetes del sistema y muestra el comando manual cuando el
  programa lo gestiona otra herramienta. nginx y dnsmasq se tratan como piezas internas de
  Valet y no aparecen como programas independientes.
- **Actualizaciones de la propia app** desde GitHub Releases, con verificación `sha512`.
- **Copias y desinstalación**: copias de configuración antes de cada cambio, reparación de DNS y
  desinstalación completa que conserva sitios y copias.
- **Tema Carbón** claro/oscuro, atajos de teclado, bandeja del sistema con estado de salud y
  ventana única con diálogos accesibles.
- **Empaquetado multiárquitectura**: AppImage, `.deb` y `.rpm` para Linux; `.dmg` y `.zip` para
  macOS; instalador NSIS para Windows. La gestión de Valet solo está disponible en Linux.
- **Integración continua** que ejecuta typecheck y pruebas, y publica la release con los
  artefactos de las tres plataformas al empujar una etiqueta `v*`.

### Seguridad

- Las operaciones privilegiadas usan `sudo -A` o `pkexec`; los ayudantes de root se instalan en
  `/usr/local/libexec/valet-studio` con propietario `root` y modo `0755`.
- Las contraseñas de MariaDB, bases de datos y correo nunca viajan al renderer; los archivos de
  credenciales se escriben con modo `0600` y de forma atómica.
- El proceso principal valida las rutas y el remitente de cada mensaje IPC, y bloquea
  navegación, ventanas nuevas y webviews.
- Los secretos no se pasan por `argv`: `htpasswd` y `tee` los reciben por entrada estándar.

### Notas

- El `.rpm` se empaqueta con `scripts/build-rpm.sh` y `build/rpm/valet-deck.spec`, porque
  electron-builder 25 usa una versión de fpm incompatible con rpm 6.
- La carpeta interna `~/.valet-studio` conserva el nombre histórico para no perder datos al
  actualizar. La marca visible y los paquetes usan **Valet Deck**.
- Los paquetes de macOS y Windows no están firmados. Al abrirlos, el sistema pedirá confirmación
  y no podrán gestionar servicios ni sitios de Laravel Valet.

[0.1.0]: https://github.com/LC-jhony/valet-deck/releases/tag/v0.1.0
