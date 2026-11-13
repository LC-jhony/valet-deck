# Valet Deck

**Valet Deck** es una aplicación de escritorio para **Linux** (Electron + React 19 + TypeScript)
que instala y gestiona un entorno de desarrollo Laravel completo con Laravel Valet, PHP, DNS,
servicios, bases de datos y correo local. No es un envoltorio de Flock ni cambia el runtime de
Valet: añade una interfaz para las piezas que ya existen en el sistema y aplica las ideas de
Flock que tienen sentido aquí.

- **Sitios** parkeados y enlazados, con ficha por sitio: `.env`, base de datos, correo, colas,
  PHP/Node.js y registros.
- **PHP** con apt, systemd y `valet isolate`; el repositorio se elige solo según la distro.
- **Node.js** con nvm, versión por defecto y `.nvmrc` por sitio.
- **Bases de datos** MariaDB, MySQL, PostgreSQL y SQLite, con guías de instalación y un bloque
  `.env` copiable para cada motor.
- **Correo integrado**: un catcher SMTP propio que arranca con el panel, sin instalar Mailpit
  ni ningún servicio aparte.
- **Servicios y puertos** con estado real, journal y detección del proceso que ocupa 80/443.
- **Correo listo para Laravel**: escribe el bloque `MAIL_*` coherente en el `.env`.
- **Actualizaciones** del propio panel desde GitHub Releases.

## Índice

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Primer arranque](#primer-arranque)
- [Secciones del panel](#secciones-del-panel)
- [Sitios y proyectos Laravel](#sitios-y-proyectos-laravel)
- [PHP y repositorios](#php-y-repositorios)
- [Node.js](#nodejs)
- [Bases de datos](#bases-de-datos)
- [Correo integrado](#correo-integrado)
- [DNS](#dns)
- [Puertos y Apache](#puertos-y-apache)
- [Servicios](#servicios)
- [Actualizaciones](#actualizaciones)
- [Desarrollo](#desarrollo)
- [Arquitectura y seguridad](#arquitectura-y-seguridad)
- [Copias, reparación y desinstalación](#copias-reparación-y-desinstalación)
- [Solución de problemas](#solución-de-problemas)

## Requisitos

- Ubuntu 24.04 LTS, 26.04 LTS o 26.10 (probado), o una distribución con `systemd` y
  NetworkManager. Debian, Fedora y Arch funcionan con el PHP de su distribución.
- Polkit (`pkexec`) con agente gráfico, o `sudo` con `zenity`/`kdialog`. El panel prefiere
  `sudo -A`: pide la contraseña una vez y la reutiliza durante la instalación; `pkexec` queda
  como respaldo.
- `systemd-resolved` activo para el **modo DNS seguro**. Si no lo está, usa el modo **Hosts**.
- Node 20+ para desarrollar o empaquetar la app.
- No hace falta instalar Valet, nginx ni Composer a mano: el **primer arranque** lo instala
  todo con una contraseña y barras de progreso por componente. Si falta algo que el panel no
  puede instalar, muestra el comando exacto. El mantenimiento (actualizaciones, DNS,
  requisitos) vive en **Settings → Maintenance**.

> En Ubuntu 26.04 y 26.10 el panel usa el **PHP de la distribución** (8.5): sus paquetes ya
> traen `libsodium26` y no se mezclan con Sury, cuyos paquetes exigen `libsodium23`. Si quedó
> un repositorio de Sury de una versión anterior, se retira con copia de seguridad al
> instalar o actualizar PHP. En las LTS 22.04 y 24.04 sigue usando el PPA de Ondřej.

## Instalación

La versión **0.1.0** es la primera publicación de esta línea. Descarga el paquete de la última
publicación y instálalo:

```bash
# AppImage: portable, sin instalar nada
curl -fLO https://github.com/LC-jhony/valet-deck/releases/download/v0.1.0/Valet-Deck-0.1.0.AppImage
chmod +x Valet-Deck-0.1.0.AppImage
./Valet-Deck-0.1.0.AppImage
```

> En Ubuntu 24.04+ el AppImage necesita `libfuse2t64`. Si el sistema restringe los
> *user namespaces*, arráncalo con `--no-sandbox`. Para uso diario se recomienda el `.deb`,
> que configura el sandbox de Electron al instalar.

```bash
# Debian, Ubuntu y derivados
curl -fLO https://github.com/LC-jhony/valet-deck/releases/download/v0.1.0/valet-deck_0.1.0_amd64.deb
sudo apt install ./valet-deck_0.1.0_amd64.deb
```

```bash
# Fedora, RHEL y derivados
curl -fLO https://github.com/LC-jhony/valet-deck/releases/download/v0.1.0/valet-deck-0.1.0.x86_64.rpm
sudo dnf install ./valet-deck-0.1.0.x86_64.rpm
```

Comprueba la descarga antes de instalar:

```bash
curl -fsSLO https://github.com/LC-jhony/valet-deck/releases/download/v0.1.0/SHA256SUMS
sha256sum -c SHA256SUMS
```

### macOS y Windows

La release también publica paquetes para macOS y Windows. Sirven para revisar la interfaz y
el código en esas plataformas, pero **no pueden gestionar Laravel Valet**: el panel controla
`systemd`, `apt` y Valet Linux, que solo existen en Linux. Para trabajar con sitios y servicios,
usa la versión de Linux.

- **macOS** (Apple Silicon): `Valet-Deck-0.1.0-arm64.dmg`.
- **macOS** (Intel): `Valet-Deck-0.1.0-x64.dmg`.
- **Windows** (x64): `Valet-Deck-Setup-0.1.0.exe`.

## Primer arranque

El instalador aparece **solo cuando falta un componente requerido**: PHP 8.5 con PHP-FPM y las
extensiones de Valet, Composer, nginx o Laravel Valet. Si ya están instalados, el panel entra
directo aunque sea el primer arranque. La ventana **Set up Valet Deck** resume cada componente
en una línea:

- **Requeridos**: PHP 8.5 con PHP-FPM y las extensiones de Valet, Composer, nginx y Laravel
  Valet con su Composer aislado.
- **Opcionales**: Node.js 26 (instala nvm si hace falta) y MariaDB (la instala, arranca y
  prepara el usuario gestionado `valet_studio`; el secure es manual).
- **Una sola ventana de contraseña**, la del sistema.
- **El DNS no se toca**: el setup no aplica DNS, no edita `/etc/hosts` ni reinicia
  `systemd-resolved`. El paso DNS se marca como omitido y el resumen lo dice.
- Antes de cambiar nada se crea una copia en `~/.valet-studio/backups`.
- **Set up later** entra sin instalar; si siguen faltando componentes requeridos, la ventana
  vuelve en el siguiente arranque.
- El **correo integrado no se instala**: arranca con el panel y escucha en `127.0.0.1:2525`.

Al terminar, **Valet Deck is ready** muestra las comprobaciones y el botón **Open Valet
Studio**.

## Secciones del panel

La barra de actividad muestra un icono y un rótulo por sección, con tooltip y un indicador de
la sección activa. Los contadores (avisos, sitios, versiones, bases, puertos, servicios y
correo) aparecen como insignias; en ventanas estrechas se ocultan los rótulos.

- **Dashboard**: estado de Valet, PHP, Node.js, servicios, bases de datos, correo y DNS, con
  los avisos antes que las cifras. Cada tarjeta lleva a su sección.
- **Sites**: sitios parkeados y enlazados. **New project** crea un Laravel; al seleccionar un
  sitio se abre su ficha con siete pestañas.
- **PHP**: versiones instaladas, la que sirve Valet, sitios aislados, repositorio PHP y
  acciones de instalar, actualizar, cancelar, quitar y aislar.
- **Node.js**: versiones de nvm, alias por defecto y fijación por sitio con `.nvmrc`.
- **Databases**: MariaDB, MySQL, PostgreSQL y SQLite, con credenciales guardadas, creación y
  borrado de bases, prueba de conexión y guías por motor.
- **Services**: arranque, parada, reinicio y journal de cada unidad de systemd.
- **Ports**: puertos de nginx y Apache, conflictos y proceso que los ocupa.
- **Mail**: bandejas, búsqueda, detalle de mensajes, adjuntos, bloque `.env` y envío de prueba.
- **Settings** (`Ctrl+,`): dominio, carpetas parkeadas, versiones por defecto, rutas y
  apariencia. En **Maintenance**: actualizaciones del panel y de los componentes, requisitos,
  modo y reparación de DNS, el secure de MariaDB y **Uninstall everything**, que retira Laravel
  Valet, PHP, Composer, Node.js 26 de nvm y MariaDB (solo si la instaló el panel), conservando
  sitios, copias y nginx.

Atajos: `Ctrl+1`…`Ctrl+8` cambian de sección, `Ctrl+B` muestra u oculta el panel lateral y
`Ctrl+,` abre Ajustes. Por debajo de 900 px el panel se convierte en una capa superpuesta.

La **bandeja del sistema** sigue al panel en segundo plano: el icono cambia entre verde, ámbar
y rojo según la salud de los servicios, y el menú resume el estado y lista los servicios y los
sitios abiertos.

## Sitios y proyectos Laravel

**Sites → New project** crea un proyecto Laravel sin salir del panel:

- Elige el **nombre** y la **carpeta** (selector nativo o ruta aparcada). Se instala la
  última versión estable de Laravel; no acepta una restricción de versión.
- Composer se ejecuta con el `COMPOSER_HOME` aislado en
  `~/.config/valet-studio/composer` y muestra el registro en vivo.
- Si eliges **MySQL** o **MariaDB**, el panel crea la base si no existe antes de ejecutar las
  migraciones. En **PostgreSQL** lo intenta con `psql`; si no está instalado, avisa y deja la
  base a tu cargo. Los nombres aceptan letras, números, `-` y `_`.
- Si la carpeta es exactamente una ruta aparcada, el sitio aparece al refrescar. Si no, se
  ejecuta `valet link <nombre>` dentro del proyecto.
- **Stop** cancela el grupo completo del instalador (Composer, PHP y Node).
- En modo **Hosts**, pulsa **Sync hosts** después de crear el proyecto para que el dominio
  nuevo resuelva.

La ficha del sitio incluye:

1. **Overview**: framework, dominios, PHP, Node.js y extensiones.
2. **`.env`**: edición con copia previa en `~/.valet-studio/backups`; los secretos nunca
   vuelven a la ventana.
3. **Database**: conexión, prueba real y escritura de `DB_*` con los datos del servidor.
4. **Mail**: bloque `MAIL_*` listo para copiar y aplicar al `.env`.
5. **Queues**: workers con unidades `systemctl --user` y sus registros.
6. **PHP & Node.js**: versión de PHP, `valet isolate`, `.flockrc` (`php=8.4`), versión de Node
   y `.nvmrc`.
7. **Logs**: registros de Laravel y de los workers.

## PHP y repositorios

Valet Deck instala PHP con apt y lo sirve con PHP-FPM y systemd. No descarga binarios propios
ni crea pools ajenos a la distribución. La página **PHP** muestra:

- Versiones instaladas, parche, última disponible, tamaño en disco y extensiones.
- La versión que sirve Valet por defecto y los sitios aislados con `valet isolate`.
- Un botón para **instalar**, **actualizar el parche**, **cancelar** un trabajo en curso,
  **quitar** una versión o **aislar** un sitio.
- La etiqueta **Xdebug** cuando esa versión carga la extensión, como en Flock.
- El pin `php=8.4` en `.flockrc`, con botones para escribir, aplicar y quitar.
- El **repositorio PHP** que corresponde a esta máquina, su suite y si apt ya lo lee.

### Qué repositorio se usa

La decisión vive en `src/shared/php-repo.ts` y es pura:

| Distro | Repositorio |
| --- | --- |
| Ubuntu 22.04 `jammy` y 24.04 `noble` | PPA de Ondřej (`ppa:ondrej/php`) |
| Ubuntu 25.04 y 25.10 | Sury, suite más nueva publicada |
| Ubuntu 26.04, 26.10 `stonking` y posteriores | PHP de la distribución (8.5) |
| Ubuntu EOL o Debian/Fedora/Arch | PHP de la distribución |

El PPA de Ondřej solo publica `jammy` y `noble`; por eso `add-apt-repository ppa:ondrej/php`
falla con 404 en 26.10. Sury publica `jammy`, `noble` y `resolute`, pero **no** `stonking`, y
sus paquetes para 26.04 exigen `libsodium23`, que 26.10 ya no publica. Por eso, desde Ubuntu
26.04 el panel usa el PHP 8.5 de la distribución y no mezcla repositorios ajenos.

La lista **PHP versions** muestra tanto las versiones instalables como las que el panel conoce
y el repositorio configurado no publica. Estas últimas aparecen como **not available** con el
motivo y el botón deshabilitado, en vez de desaparecer sin explicación. En Ubuntu 26.10 solo
hay PHP 8.5: es normal que 8.1–8.4 figuren como no disponibles.

El repositorio se toca **solo cuando el paquete PHP falta** en los orígenes actuales. La
tarjeta **PHP repository** muestra los comandos equivalentes para hacerlo a mano.

### Instalar o actualizar una versión

La instalación ejecuta `apt-get` con los mismos tiempos e inglés que el instalador principal.
Pide la contraseña de administrador, instala `phpX.Y-fpm` y las extensiones comunes y no toca
las demás versiones. Una actualización instala el parche más reciente de la misma minor.

**Cancelar** mata el `apt-get` en curso y repara los paquetes a medio configurar con
`dpkg --configure -a`, de modo que el siguiente intento no hereda el bloqueo. **Remove** purga la
versión y sus extensiones con `apt-get purge`, pero solo si no es la predeterminada, no tiene
sitios aislados y no tiene un trabajo en curso; el motivo se muestra en la propia fila.

## Node.js

- Instala versiones con **nvm** (no con apt), las elimina y cambia el alias por defecto.
- nvm se clona de su repositorio oficial en una etiqueta fijada y se verifica el commit antes
  de ejecutarlo; no se ejecuta un instalador remoto.
- La ficha del sitio escribe `.nvmrc` con la versión elegida.
- La fila de actualizaciones de Node sigue siendo manual.

## Bases de datos

La página **Databases** detecta MariaDB, MySQL, PostgreSQL y los archivos SQLite de cada sitio.
Cada motor muestra estado, versión, host, puerto, usuario, bases, tamaño y tablas. Las
credenciales se guardan en `~/.valet-studio/databases.json` con permisos `0600`; la contraseña
solo se usa desde el proceso principal y nunca vuelve a la ventana.

El estado distingue **no instalado** de **instalado pero parado**. Solo aparecen tarjetas de
los motores cuyo servidor está instalado; un MariaDB parado muestra el botón **Start MariaDB**
y un aviso claro, no un error de conexión. MySQL y PostgreSQL ausentes se agrupan en **Other
database engines**, con su guía de instalación, y no generan avisos falsos. Un cliente suelto
—por ejemplo el `psql` que trae Flock en `~/.local/share/flock/bin`— no cuenta como servidor.

Cada tarjeta instalada incluye **Connection settings** (host, puerto, usuario, contraseña,
guardar y probar). Las guías de **Install and connect** tienen instrucciones para `apt`
(Ubuntu/Debian), `dnf` (Fedora) y `pacman` (Arch), más el bloque `.env` de Laravel con los
datos reales del servidor. La contraseña aparece como `change-me`: es un marcador, no la
credencial guardada.

### MariaDB

```bash
sudo apt-get update
sudo apt-get install -y mariadb-server mariadb-client
sudo systemctl enable --now mariadb
sudo mariadb -e "SELECT VERSION();"
```

El instalador crea o comprueba el usuario gestionado `valet_studio` (en `localhost` y
`127.0.0.1`) y guarda su contraseña en `~/.valet-studio/mariadb.json` (0600). El **secure
installation** (usuarios anónimos, base `test`, root remoto) es manual: se abre desde la
tarjeta **MariaDB security**.

### MySQL

```bash
sudo apt-get install -y mysql-server
sudo systemctl enable --now mysql
sudo mysql -e "SELECT VERSION();"
```

MySQL y MariaDB comparten el puerto 3306: ejecuta solo uno salvo que cambies el puerto. En
Arch la unidad es `mysqld`; en Ubuntu y Fedora es `mysql` o `mariadb` según el paquete.

### PostgreSQL

```bash
sudo apt-get install -y postgresql postgresql-contrib php8.5-pgsql
sudo phpenmod pdo_pgsql
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "SELECT version();"
```

PHP necesita `pdo_pgsql`; después de instalar el driver, reinicia PHP-FPM:
`sudo systemctl restart php8.5-fpm`. En una instalación nueva, las conexiones locales usan
autenticación `peer`; crea un usuario con contraseña y usa `127.0.0.1` en `.env` para conectar
por TCP.

### SQLite

```bash
sudo apt-get install -y php8.5-sqlite3
touch database/database.sqlite
php artisan migrate
```

No hay servidor, usuario ni puerto. El panel lista los archivos SQLite de los sitios, pero no
los modifica.

### `.env` de Laravel

```dotenv
DB_CONNECTION=mysql        # o pgsql / sqlite
DB_HOST=127.0.0.1
DB_PORT=3306               # 5432 en PostgreSQL
DB_DATABASE=my_app
DB_USERNAME=valet_studio
DB_PASSWORD=change-me
```

En SQLite solo hacen falta `DB_CONNECTION=sqlite` y `DB_DATABASE` con la ruta absoluta al
archivo.

## Correo integrado

El panel trae su propio servidor SMTP de recepción: **no hay que instalar Mailpit ni ningún
servicio aparte**. El catcher arranca con el panel y escucha solo en `127.0.0.1:2525`; si ese
puerto está ocupado, prueba `2526`–`2529`. Si el puerto antiguo `1025` está libre, también lo
atiende para que los `.env` existentes sigan funcionando.

Si detecta el servicio Mailpit de una compilación interna anterior, el panel lo detiene y lo
retira en el primer arranque y conserva sus mensajes en `~/.valet-studio/mailpit`; el correo
nuevo ya cae en `~/.valet-studio/mail`.

- **Bandejas por usuario SMTP**: `MAIL_USERNAME` elige el buzón. Los mensajes de cada proyecto
  quedan separados. Sin usuario, con `MAIL_USERNAME=null` o con una cadena vacía, el mensaje
  cae en la bandeja **`default`**; no se pierde.
- **Credenciales**: el catcher acepta **cualquier usuario y cualquier contraseña**. La
  contraseña no se comprueba: el panel escribe `MAIL_PASSWORD=null` y el cliente SMTP puede
  enviar lo que tenga guardado. El usuario solo decide la bandeja.
- **Recepción sin TLS** en loopback y un máximo de **25 MB** por mensaje, adjuntos incluidos.
- **Mensajes en disco** como `.eml` bajo `~/.valet-studio/mail/<bandeja>/`; la pestaña los
  lista del más nuevo al más antiguo, permite buscar, borrar uno o vaciar una bandeja y abrir
  la carpeta.
- **Detalle con HTML, texto, crudo y cabeceras**: el HTML se muestra en un iframe aislado, sin
  scripts ni formularios, y los enlaces se abren en el navegador. Los adjuntos se guardan con
  el diálogo del sistema.
- **Integración con Laravel**: la ficha del sitio escribe el bloque `MAIL_*` en el `.env` (con
  copia previa) y la página de Correo muestra el bloque listo para copiar. Al cambiar el
  cifrado se escriben siempre los dos pares coherentes: `MAIL_SCHEME=null` +
  `MAIL_ENCRYPTION=null`, `smtp` + `tls` o `smtps` + `ssl`.
- **Prueba desde la interfaz**: el formulario envía un mensaje a la bandeja indicada y confirma
  que apareció en disco.

Bloque que escribe el panel:

```dotenv
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=2525
MAIL_USERNAME="${APP_NAME}"
MAIL_PASSWORD=null
MAIL_SCHEME=null
```

`MAIL_USERNAME="${APP_NAME}"` es solo el ejemplo: el nombre que pongas se normaliza y se usa
como bandeja. Para compartir una sola bandeja entre proyectos, deja `MAIL_USERNAME=null` y todo
caerá en `default`. La contraseña no se valida: cualquier valor funciona y el panel escribe
`null` para que quede claro que el catcher no la usa.

## DNS

- **Seguro (recomendado)**: `dnsmasq` escucha solo en `127.0.0.1:5354` y `systemd-resolved`
  recibe una ruta `~test` en `/etc/systemd/resolved.conf.d/valet-studio.conf`. No se detiene
  NetworkManager, no se reescribe `/etc/resolv.conf` y no se desactiva `systemd-resolved`. El
  puerto 5354 se eligió para no chocar con mDNS/Avahi (5353).
- **Hosts**: no hay daemon DNS. La app sincroniza un bloque gestionado en `/etc/hosts` con los
  sitios de Valet. Úsalo si `systemd-resolved` no está activo o si algo ocupa 5354. Tras
  enlazar un sitio desde la terminal, pulsa **Sync hosts**.
- **Clásico**: deja que Valet instale su propio DNS. Puede detener `systemd-resolved`,
  reescribir `/etc/resolv.conf`, tocar NetworkManager y cortar Wi-Fi/DNS. Solo para diagnóstico
  avanzado; el modo seguro es el valor por defecto.

Antes de cualquier cambio de red se guarda una copia en
`~/.valet-studio/backups/<fecha>/dns`. El instalador comprueba que `*.test` resuelva y que el
DNS general siga funcionando; si falla, retira su configuración y reinicia `systemd-resolved`.

## Puertos y Apache

La pestaña **Ports** permite cambiar HTTP/HTTPS de Valet (nginx) y de Apache:

- Comprueba que el puerto esté libre y avisa si lo ocupa otro proceso.
- Valida con `nginx -t` o `apache2ctl configtest`, guarda copias y restaura si la recarga falla.
- Si Apache ocupa 80/443 puedes moverlo a 8080/8443 o detenerlo desde la tarjeta, sin
  deshabilitar dnsmasq ni tocar la configuración de red.
- No se permite usar 53, 67, 68, 123, 5353 ni 5354 para nginx.

Cuando nginx o PHP-FPM están instalados pero detenidos, el Dashboard lo dice en un bloque
**Valet is stopped** o **Valet is partially running** y ofrece el botón para arrancarlos. Si
otro servicio ocupa 80/443, el bloque nombra al dueño real —por ejemplo
`Flock (flock@jhony.service)`— detectado por el cgroup del socket, no un genérico «otro
usuario».

Como nginx y Flock no pueden escuchar a la vez en los mismos puertos, el bloque ofrece
**Stop Flock and start nginx**. La acción pide confirmación, para la unidad detectada y arranca
nginx; la casilla **Keep it off at boot** también la deshabilita al arranque para que no vuelva
a tomar los puertos tras reiniciar. El panel nunca mata un proceso por su nombre: solo actúa
sobre una unidad que está escuchando de verdad en los puertos de Valet.

## Servicios

La página **Services** lista las unidades de systemd relacionadas con el entorno (nginx,
PHP-FPM, MariaDB, DNS, etc.) y permite arrancar, parar, reiniciar y ver el journal. Las
acciones elevadas usan el mismo diálogo de contraseña que el instalador.

## Actualizaciones

El panel se actualiza por sí mismo desde sus releases de GitHub. En
**Settings → Maintenance → Valet Deck** hay tres acciones: **Check now** consulta la última
versión, **Download** baja el paquete y **Restart and install** lo aplica y reabre la app.

- El `.deb` y el `.rpm` piden la contraseña una vez con el diálogo de polkit (`pkexec`). Si el
  sistema no tiene polkit, descarga e instala el paquete a mano.
- El AppImage se reemplaza a sí mismo; debe estar en una carpeta escribible.
- La descarga se verifica con el `sha512` publicado en `latest-linux.yml` antes de instalar.

La 0.1.0 ya incluye el actualizador: las siguientes versiones se instalan desde
**Settings → Maintenance → Valet Deck**.

## Desarrollo

```bash
npm install
npm run dev        # desarrollo con recarga
npm test           # pruebas unitarias (Vitest)
npm run typecheck  # TypeScript sin emitir
npm run build      # compila out/
npm run dist       # typecheck + tests + AppImage + .deb + .rpm en dist/
npm run dist:rpm   # solo el .rpm (usa rpmbuild)
npm run dist:mac   # .dmg y .zip para macOS (requiere macOS)
npm run dist:win   # instalador NSIS para Windows (requiere Windows o Wine)
npm run release    # compila Linux, prepara notas, SHA256SUMS y latest-linux.yml
```

El flujo de `.github/workflows/release.yml` compila Linux, macOS y Windows en runners nativos
cuando se empuja una etiqueta `v*`. La release se crea con todos los artefactos adjuntos.

## Arquitectura y seguridad

- `src/main`: proceso principal. Ejecuta comandos con `execFile` y arrays de argumentos (sin
  shell), salvo los guiones elevados que se validan antes. Los paquetes, copias y DNS usan
  `sudo -A` (una sola contraseña) o `pkexec` como respaldo; Valet usa su propio `sudo` con
  `askpass`.
- `src/preload`: API mínima expuesta con `contextBridge` (`window.api`).
- `src/shared`: contratos y lógica pura (planes, versiones, PHP, correo, guías de bases de
  datos, `.env`). Se puede probar sin tocar el sistema.
- `src/renderer`: interfaz React con el tema Carbón y sus tokens. El correo es una vista
  propia, sin web embebida.
- Las contraseñas de MariaDB, bases de datos y correo nunca viajan al renderer. Los archivos
  de credenciales se escriben con permisos `0600` y de forma atómica.
- El Composer global no se toca. Para ver el Valet que gestiona Valet Deck:
  `~/.config/valet-studio/composer/vendor/bin/valet --version`.

## Copias, reparación y desinstalación

> La carpeta interna `~/.valet-studio` conserva ese nombre histórico. Se mantiene para que
> actualizar no pierda el Composer aislado, las copias ni el correo guardado.

- Cada instalación guarda copias de `/etc/nginx`, `/etc/php`, `/etc/apache2`, DNS,
  `/etc/hosts` y `/usr/local/bin/valet` en `~/.valet-studio/backups`.
- **Repair DNS** vuelve a aplicar el modo elegido sin reinstalar Valet.
- **Uninstall** ejecuta `valet uninstall` (sin `--force`) con la protección DNS, elimina el
  servicio DNS de Valet Deck y quita el paquete del Composer aislado. No desinstala un Valet
  externo detectado fuera del Composer de Valet Deck.
- **Uninstall everything** (Settings → Maintenance) deja la máquina limpia: quita Valet, el
  servicio DNS, el Composer aislado, PHP de la versión gestionada, Composer del sistema,
  Node.js 26 de nvm y MariaDB solo si consta que la instaló el panel. Los sitios, las copias y
  nginx se conservan; el siguiente arranque abre el instalador con lo que falte.
- Si instalaste el modo **clásico**, revisa después los restos de DNS de Valet
  (`/etc/dnsmasq.d/valet`, `/opt/valet-linux`, `/etc/NetworkManager/conf.d/valet.conf`).
- Si un paso falla, corrige la causa y vuelve a ejecutar el primer arranque (o pulsa
  **Repair installation** si conservas esa pantalla). Los pasos ya completados se omiten o se
  repiten sin duplicar configuración.
- El `postrm` del paquete detiene los servicios del panel, deshace el DNS y el bloque de
  `/etc/hosts`, retira los ayudantes de root y borra los datos del usuario. MariaDB solo se
  purga si consta que la instaló el panel.

## Solución de problemas

### «nginx is stopped» o «php8.5-fpm is installed but stopped»

El aviso solo aparece si el servicio **existe** y está detenido. Arráncalo desde **Services**:

```bash
sudo systemctl start nginx php8.5-fpm
```

Si nginx no arranca, revisa `sudo nginx -t` y el journal con
`journalctl -u nginx -n 50 --no-pager`. Si el aviso dice que otro proceso ocupa el puerto, la
tarjeta **Ports** muestra cuál es y permite mover nginx o Apache.

### Los puertos 80/443 están ocupados por Flock

Es normal si Flock está activo. El panel lo detecta por el cgroup del socket y lo muestra como
`Flock (flock@<usuario>.service)` en el bloque de estado de Valet. Desde ahí puedes pulsar
**Stop Flock and start nginx**; si marcas **Keep it off at boot**, Flock tampoco volverá a
tomar los puertos al reiniciar. A mano, el equivalente es:

```bash
sudo systemctl stop flock@$USER.service
sudo systemctl disable flock@$USER.service   # solo si no lo quieres al arranque
sudo systemctl start nginx
```

### PHP no aparece en Ubuntu 26.10

Ubuntu 26.10 (`stonking`) solo publica **PHP 8.5**. El PPA de Ondřej y Sury no tienen paquetes
para esa suite, así que la página **PHP → PHP versions** muestra 8.1–8.4 como **not available**
con el motivo, y deja instalable solo lo que el repositorio ofrece. No hace falta añadir Sury:
la tarjeta **PHP repository** debe decir **Distribution PHP**. Para comprobarlo a mano:

```bash
apt-cache policy php8.5-cli
apt-cache search --names-only '^php[0-9]+\.[0-9]+-fpm$'
```

### El correo de Laravel no llega

Comprueba que el panel está abierto (el catcher vive dentro de la app), que el `.env` apunta a
`127.0.0.1:2525` y que `MAIL_USERNAME` no lleva caracteres raros. La página **Mail** muestra el
puerto real, la tarjeta de credenciales y el bloque `.env` listo para copiar. Recuerda: cualquier
contraseña vale y `MAIL_PASSWORD=null` es lo esperado; el usuario elige la bandeja y sin usuario
todo cae en `default`. Si el puerto 2525 estaba ocupado, usa el que indique la cabecera.

### Una base de datos no conecta

- MariaDB/MySQL: comprueba el puerto 3306 y que el usuario exista para `localhost` y
  `127.0.0.1`. El secure installation es manual.
- PostgreSQL: instala `php8.5-pgsql`, reinicia PHP-FPM y usa `127.0.0.1` en `.env` si la
  autenticación local es `peer`.
- SQLite: la ruta de `DB_DATABASE` debe ser absoluta y el archivo debe existir.

### «Operation cancelled»

Cancelaste el diálogo de contraseña. No es un fallo: vuelve a intentar la acción y escribe la
contraseña en la ventana del sistema.

## Licencia

Valet Deck se publica bajo la licencia **MIT**. Consulta el archivo
[`LICENSE`](LICENSE) para el texto completo.
