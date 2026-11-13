# Historial interno (0.1.0 – 0.4.0)

Este archivo conserva el historial de desarrollo anterior a la primera publicación pública de
**Valet Deck**, que durante esa etapa se llamó Valet Studio. Esas versiones nunca se publicaron
como releases estables y sus números no se continúan: la versión pública arranca de nuevo en
**0.1.0**.

El registro vigente está en [`CHANGELOG.md`](../CHANGELOG.md).

---

Todos los cambios relevantes de este proyecto se anotan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado
[SemVer](https://semver.org/lang/es/).

## [0.4.0] — 2026-11-11

### Añadido

- **Instalador de primer arranque con progreso**: barra global con porcentaje y una barra
  dentro de cada aplicación (animación honesta mientras corre, 100 % al terminar; apt no
  publica un porcentaje). Cada componente recibe su check en cuanto termina su paso, sin
  esperar al final.
- **Desinstalación completa**: Settings → Maintenance ofrece **Uninstall everything** con el
  alcance a la vista. Retira Valet, el DNS del panel, PHP de la versión gestionada, Composer,
  Node.js 26 de nvm y MariaDB solo si la instaló el panel; conserva sitios, copias y nginx, y
  el siguiente arranque abre el instalador con lo que falte.
- **Bandeja con salud visible**: el icono cambia entre verde, ámbar y rojo según los servicios
  activos, el tooltip resume la salud y el menú usa puntos de color por servicio, además del
  submenú de sitios.
- **Correo en el setup**: el catcher integrado aparece como componente desde el primer
  minuto, con su check, el puerto real y un botón **Open inbox**. La pantalla de listo añade
  «Open mail inbox» y recuerda la dirección SMTP (127.0.0.1:2525).
- **Salir del setup a una pestaña concreta**: abrir la bandeja desde el setup entra
  directamente en la pestaña Mail.

- **Panel completo al estilo de Flock**: la app pasa de cinco secciones a nueve más una
  página de ajustes. El **Dashboard** reúne el estado de Valet, PHP, Node.js, servicios,
  bases de datos, correo y DNS; los avisos aparecen antes que las cifras y cada tarjeta
  enlaza con su sección.
- **Ficha de sitio con siete pestañas**: resumen (framework, dominios, extensiones), `.env`
  editable con copia previa en `~/.valet-studio/backups` y secretos que nunca vuelven a la
  ventana, conexión de base de datos con prueba real, correo SMTP con el catcher integrado y
  una bandeja por usuario, colas con unidades `systemctl --user`, aislamiento de PHP, versión
  de Node con `.nvmrc` y registros de Laravel y de los workers.
- **Correo listo para copiar**: la pestaña Mail muestra el bloque `MAIL_*` real del `.env`,
  con un botón para copiarlo entero. `MAIL_SCHEME` y `MAIL_ENCRYPTION` se escriben siempre
  como un par coherente (`none` → `null`/`null`, `tls` → `smtp`/`tls`, `ssl` → `smtps`/`ssl`).
  La interfaz aclara que el usuario SMTP elige la bandeja y que cualquier contraseña vale.
- **Catálogo de PHP con parche y tamaño**: cada versión instalada muestra su parche, la última
  disponible, el tamaño en disco, la extensión instalada y el estado del trabajo, con el log
  de instalación a mano. Desde la ficha del sitio se puede instalar, actualizar el parche y
  aislar; el pin `php=8.4` se guarda en `.flockrc` y se puede aplicar o quitar.
- **Versiones de PHP**: página para instalar versiones con apt (mismos tiempos y salida en
  inglés que el instalador), elegir la que sirve Valet y ver los sitios aislados. Como en Flock,
  cada fila muestra si la versión carga **Xdebug**, un trabajo en curso se puede **cancelar** y
  una versión ya instalada se puede **quitar** con `apt-get purge` (nunca la predeterminada, ni
  una con sitios aislados, ni mientras corre un trabajo).
- **Versiones de Node.js**: instalación y borrado con nvm, alias por defecto y fijación por
  sitio mediante `.nvmrc`.
- **Bases de datos**: MariaDB, MySQL, PostgreSQL y SQLite con estado, tamaño y tablas,
  credenciales guardadas con permisos 0600, prueba de conexión y creación/borrado de bases
  con confirmación.
- **Logs de servicios**: cada unidad de systemd muestra su journal (`journalctl`) en un panel
  de solo lectura, sin elevar privilegios.
- **Página de ajustes**: dominio de desarrollo, carpetas parkeadas, versiones por defecto,
  rutas de datos y acceso a tema, paleta, fuente y tamaño. `Ctrl+,` abre esta página.
- **Navegación**: `Ctrl+1`…`Ctrl+9` recorren las nueve secciones; el icono de la marca lleva
  al Dashboard y la barra de estado distingue singular y plural.
- **Barra de progreso al crear proyectos**: el asistente ya no muestra el registro durante
  la creación; muestra una barra que avanza por fases (instalador, base de datos,
  `laravel new`, `.env`, Valet) y sigue avanzando dentro de cada fase para que una
  descarga larga de Composer no parezca un cuelgue. El registro solo aparece si algo falla.
- **Credenciales de base de datos a mano**: en el paso «Database» el usuario por defecto es
  `root` y la contraseña se escribe en el asistente; ya no se rellena con el usuario
  gestionado `valet_studio` de `~/.valet-studio/mariadb.json`.
- **Soporte para Ubuntu sin soporte (p. ej. 20.10 «groovy»)**: nuevo módulo `platform.ts`
  que lee `VERSION_ID`/`VERSION_CODENAME`, sabe qué versiones están en EOL y decide el PHP.
  En una Ubuntu en EOL el instalador avisa, redirige los orígenes de apt a
  `old-releases.ubuntu.com` (con copia en `/var/backups/valet-studio/`) y usa el PHP de la
  distribución en lugar del PPA de Ondřej, que no publica paquetes para esas versiones.
- **Identidad de «entorno local de Laravel»**: logo nuevo (elefante azul sobre una baldosa
  azul noche, con el nombre y la descripción del producto), el mismo icono en la ventana, la
  bandeja y los paquetes de Linux; barra de actividad con la marca arriba, sin la pastilla
  *Local*, y etiqueta *Laravel · local*
  en la barra de estado y descripción del producto en las pantallas de arranque.
- **Correo propio en lugar de Mailpit**: servidor SMTP embebido que arranca con el panel en
  `127.0.0.1:2525` (2526–2529 si están ocupados, y `1025` si está libre), bandejas por
  usuario SMTP, almacenamiento `.eml` en `~/.valet-studio/mail`, límite de 25 MB, vista
  HTML/texto/crudo/cabeceras, adjuntos, búsqueda, borrado y vaciado. La página incluye
  bloque `.env` con el puerto real, envío de prueba y apertura de la carpeta de datos; no se
  instala ni se descarga nada.
- **Repositorio PHP elegido según la distribución**: el panel decide entre el PPA de Ondřej
  (`jammy`, `noble`) y Sury (`resolute` o la suite más nueva publicada) leyendo el
  `VERSION_ID`/`VERSION_CODENAME` del sistema. En Ubuntu 26.10 el PPA no existe y la
  instalación fallaba con 404; ahora escribe la clave y la línea `signed-by` de Sury y
  refresca apt solo cuando el paquete falta. La tarjeta **PHP repository** muestra la
  decisión, la suite y los comandos equivalentes.
- **Guías de bases de datos**: cada tarjeta de MariaDB, MySQL, PostgreSQL y SQLite incluye
  **Install and connect** con pasos para `apt`, `dnf` y `pacman`, las unidades de systemd,
  notas del motor y un bloque `.env` copiable con los datos reales del servidor.
- **Barra de actividad con rótulos e insignias**: cada sección muestra icono y nombre, la
  sección activa lleva una barra lateral y los contadores aparecen como insignias. El rail
  mide 78 px y se reduce a 56 px con rótulos ocultos en ventanas estrechas.

### Corregido

- **El instalador solo aparece si hace falta**: la puerta de arranque ya no depende de
  `localStorage` ni del primer arranque. Si PHP, Composer, nginx y Valet ya están instalados, el
  panel entra directo; **Set up Valet Studio** queda para cuando falta un componente requerido.
- **Setup compacto**: cada aplicación se describe en una línea dentro de una única lista con
  separadores finos, sin tarjetas por fila. La versión de Valet se lee de `Valet v2.4.5` aunque
  `valet --version` escupa avisos de PHP antes. Valet ya no se marca como **missing** cuando
  existe pero su versión no se puede leer: basta con que el binario esté instalado.
- **Estado de Valet y conflicto con Flock**: el Dashboard muestra un bloque propio con cuatro
  estados (running, stopped, partial, blocked). Si otro servicio ocupa 80/443, nombra la unidad
  real y ofrece **Stop Flock and start nginx**, con confirmación y la casilla **Keep it off at
  boot**; nunca mata un proceso por su nombre. Los avisos genéricos de nginx y PHP-FPM dejan de
  duplicarse.
- **Catálogo de PHP honesto**: la página **PHP versions** enseña también las versiones que el
  panel conoce y el repositorio no publica, marcadas como **not available** con el motivo. En
  Ubuntu 26.10 solo PHP 8.5 es instalable; 8.1–8.4 ya no fingen estar disponibles, porque el
  PPA y Sury no publican la suite `stonking`.
- **Bases de datos ausentes frente a paradas**: `installed` significa servidor instalado, no
  cliente CLI. MariaDB parada muestra **Start MariaDB**; MySQL y PostgreSQL ausentes pasan a una
  sección de guías y no generan avisos. El `psql` que Flock deja en `~/.local/share/flock/bin`
  ya no se confunde con una instalación del sistema.
- **Credenciales de correo explícitas**: la página **Mail** y la pestaña Mail del sitio
  documentan que el usuario elige la bandeja, que sin usuario todo cae en `default`, que
  cualquier contraseña vale y que el panel escribe `MAIL_PASSWORD=null`.
- **Interfaz minimalista**: rail y barra lateral planos, menos brillos y bordes más suaves,
  paneles y métricas con menos ruido visual, y un bloque de estado de Valet y una tarjeta de
  credenciales de correo integrados en el mismo lenguaje.
- **PHP en Ubuntu 26.04 y 26.10 (stonking)**: la distribución ya trae PHP 8.5 con `libsodium26`,
  así que el panel usa su paquete en vez de Sury, cuyos paquetes para 26.04 (`resolute`)
  exigen `libsodium23` —que 26.10 no publica— y dejaban «Unable to satisfy dependencies» al
  actualizar. El aviso obsoleto «…will come from the newest Sury suite (resolute)» desaparece.
- **Sury obsoleto tras actualizar Ubuntu**: si quedó `/etc/apt/sources.list.d/sury-php.list` de
  una versión anterior, se retira automáticamente (con copia en `~/.valet-studio/backups/apt`)
  antes de instalar o actualizar PHP y se refrescan los índices. La pestaña PHP avisa de que
  el origen está obsoleto mientras siga ahí.
- **Avisos de nginx y PHP-FPM**: el Dashboard solo avisa de un servicio detenido cuando la
  unidad existe de verdad y explica el efecto (sitios que no abren o error 502). Antes podía
  mostrar «nginx is not running» en equipos donde nginx no estaba instalado.
- **Puertos 80/443 de Flock**: la detección usa `ss -tlnpHe` y atribuye el socket por cgroup y
  uid, así que un proceso de otro servicio aparece con su nombre real (`Flock
  (flock@usuario.service)`) en vez de «another process» o «otro usuario».
- **Restos de Mailpit al actualizar**: al arrancar, el panel detiene y retira el servicio de
  usuario `valet-studio-mailpit.service` y su binario de la 0.3.x, para que el catcher
  integrado recupere 2525/1025. Los mensajes antiguos se conservan en
  `~/.valet-studio/mailpit`.
- **Aislamiento de PHP visible**: Valet Linux escribe la configuración aislada como
  `~/.valet/Nginx/<sitio>.<dominio>` (sin `.conf`), no solo con extensión. El panel lee ambas
  formas, muestra el sitio como `isolated` y enseña la ruta real de su configuración.
- **Volver al PHP por defecto sin romper nginx**: al desaislar un sitio sin certificado, Valet
  Linux reescribe una configuración «secure» con rutas de certificado que no existen y nginx
  se niega a arrancar. El panel detecta ese caso, elimina el archivo propio del sitio y
  reinicia nginx, que es el estado que Valet pretendía dejar.
- **Log de colas vacío**: la pestaña Queues de un sitio sin trabajos ya no deja esqueletos
  de carga para siempre; muestra «No output yet» y distingue un error real del panel.
- **Textos obsoletos**: la barra de PHP ya no dice que el panel gestiona una sola versión;
  explica el aislamiento por sitio con `valet isolate`. La ayuda de Sites describe la ficha
  con sus pestañas en vez de «locate it in the main area».
- **Singular y plural**: sitios, bases de datos y motores cuentan una unidad con la forma
  correcta («1 site», «1 database», «1 engine running») en la barra lateral, el Dashboard y
  la barra de estado.
- **«Install system dependencies» se quedaba colgado**: apt podía pasar 15 minutos
  esperando una descarga estancada y el instalador lo mataba sin más pista. Ahora cada
  conexión de apt se corta a los 30 s y se reintenta, la salida de apt va en inglés para
  que el diagnóstico reconozca los mensajes, el paso publica un latido cada 30 s con el
  tiempo transcurrido, los paquetes tienen 30 minutos de margen y un fallo de descarga se
  explica con la última URL y un reintento. Al cancelar o agotar el tiempo se fuerza la
  salida de apt/dpkg para no dejar el bloqueo tomado.
- **Empaquetado `.deb`/`.rpm`**: el `.deb` vuelve a generarse (faltaba `homepage` en
  `package.json`) y las entradas de escritorio incluyen nombre genérico, palabras clave y
  notificación de arranque. Los iconos se instalan en todos los tamaños (16–1024) con el logo
  nuevo.
- **Ventana de setup**: el cuerpo de la tarjeta hace scroll y el pie con los botones queda
  siempre visible. En la ventana por defecto (1100×720) «Install missing components» ya no
  aparecía cortado por el borde inferior.
- **Cancelar la contraseña**: los avisos de `zenity`/GTK que llegan por `stderr` se filtran y
  la cancelación de `sudo`/`pkexec` se muestra como `Operation cancelled`, no como un error
  críptico. Una contraseña incorrecta tiene un mensaje propio.
- **Scroll horizontal en Installation**: la lista de avisos del sistema ya envuelve el texto y
  no ensancha la página.
- `mariadb-secure-installation` no existe en MariaDB 10.3 (Ubuntu 20.04/20.10): ahora se usa
  `mysql_secure_installation` cuando es el único disponible.
- MariaDB: se espera a que el servicio acepte conexiones antes de crear el usuario gestionado,
  se reintentan los errores transitorios de conexión y las credenciales se guardan con
  escritura atómica (sin JSON truncado si el proceso muere a medias).
- Crear la base de un proyecto ya no falla si otra ejecución la creó entre la comprobación y el
  `CREATE DATABASE`.
- El PHP objetivo de `valet.ts` y el del instalador usan ahora la misma regla (`planPhp`).

### Añadido (anterior)

- **Ventana de primer arranque inspirada en Flock**: al abrir la app, si faltan PHP 8.5,
  Composer, nginx o Laravel Valet (o es el primer arranque), se muestra **Set up Valet
  Studio** con el estado de cada componente, la opción de instalar Node.js 26 y MariaDB, el
  progreso, el registro y una pantalla **Valet Studio is ready**. **Set up later** permite
  entrar sin instalar; la ventana vuelve si siguen faltando requeridos.
- **Base de datos por proyecto**: al crear un proyecto Laravel con MySQL o MariaDB, el panel
  crea la base si no existe antes de `artisan migrate`, como Flock. En PostgreSQL lo intenta
  con `psql`; si falta el cliente, avisa y deja la base a mano. No copia datos ni borra bases.
- La ventana de setup instala con **`skipDns`**: no aplica DNS, no edita `/etc/hosts`, no
  limpia restos clásicos y no comprueba la resolución. El paso aparece como omitido y el
  resumen lo dice. La pestaña **Instalación** conserva su flujo con DNS.
- `src/shared/setup.ts` decide qué componentes faltan y cuáles son opcionales; tiene
  pruebas propias (`src/shared/setup.test.ts`).

- **Desinstalación completa con `sudo apt remove valet-studio`**: el `postrm` del paquete
  detiene los servicios del panel (DNS, nginx, PHP-FPM y MariaDB si la instaló el
  panel), deshace el DNS y el bloque gestionado de `/etc/hosts`, retira los ayudantes de root
  y borra los datos del usuario (`~/.valet-studio`, el Composer aislado, la caché de Electron y
  `~/.valet` cuando el Valet activo era el del panel), junto con la configuración que
  `valet install` deja fuera de dpkg (sitio de nginx y pool de PHP-FPM). Después, ya fuera del
  bloqueo de apt, purga nginx, PHP 8.5, Composer, dnsmasq-base y libnss3-tools; MariaDB solo si
  la instaló el panel. También elimina Node.js 26 de nvm.
- El purgado se programa con `systemd-run --on-active=3` porque un script de dpkg no puede
  llamar a `apt-get` en primer plano: el lock de apt seguiría tomado y la desinstalación se
  quedaría esperando. Si no hay systemd, se lanza con `setsid` y un registro en
  `/var/log/valet-studio-cleanup.log`.
- La limpieza solo actúa en `remove` y `purge`. En una actualización (`upgrade`) no toca nada.

### Quitado

- **Pestaña Installation**: desaparece de la barra de actividad. Todo lo necesario se instala
  en el primer arranque y el mantenimiento que vivía allí (actualizaciones del panel y de los
  componentes, requisitos, modo y reparación de DNS, secure de MariaDB y desinstalar el Valet
  gestionado) se reúne en **Settings → Maintenance**. El Dashboard y el panel lateral enlazan
  ahora con Settings; si falta algo requerido, la ventana de primer arranque vuelve sola.
- **Mailpit**: se eliminan el binario gestionado, el servicio de usuario, la vista embebida
  con `WebContentsView`, la configuración `MP_*`, la autenticación Basic/TLS, el relay, el
  POP3, la API, la integración de `sendmail_path` y su instalación opcional. El correo pasa a
  ser una función del propio panel y desaparece el puerto `8025`.

### Cambiado

- **Una sola versión de PHP, Node.js y MariaDB**: el panel deja de ofrecer varias versiones.
  Instala y usa siempre **PHP 8.5** en Ubuntu; Debian, Fedora y Arch usan el PHP único de
  la distribución. **Node.js 26** con nvm como versión por defecto y la **MariaDB del
  sistema**. Desaparecen los selectores, la lista de versiones y el cambio de versión.
- `src/shared/stack.ts` es ahora la única fuente de verdad de las versiones y de nvm;
  sustituye a `src/shared/php.ts` y `src/shared/node.ts`.
- La pestaña **PHP** pasa a ser informativa: muestra si PHP 8.5 y su PHP-FPM están
  instalados y activos, sin botón para cambiar de versión.
- Si PHP 8.5 no está en los repositorios configurados de Ubuntu, el instalador añade el
  PPA de Ondrej y refresca los índices automáticamente. Ya no hay botón ni paso manual.
  En Debian el PPA de Launchpad no existe: allí se usa el PHP de la distribución.
- Las versiones de PHP y Node que ya estén en el equipo **no se desinstalan**: el panel
  simplemente deja de gestionarlas.
- **El secure de MariaDB es manual**: el instalador ya no elimina usuarios anónimos, la base
  `test` ni el root remoto, y no cambia contraseñas de `root`. Solo crea o comprueba el
  usuario `valet_studio` y reutiliza siempre la contraseña guardada.
  `mariadb-secure-installation` se abre desde la tarjeta de seguridad.
- La pestaña **Instalación** permite desmarcar MariaDB, igual que la ventana de primer
  arranque; antes se instalaba siempre que hubiera un gestor de paquetes.

### Corregido

- El borrado del bloque de `/etc/hosts` exige ahora que estén el marcador de inicio **y** el de
  cierre. Si faltaba el de cierre, el filtro se llevaba todas las líneas siguientes del fichero.
- No toca otras versiones de PHP, conserva nvm y el resto de versiones de Node, y no borra los
  proyectos Laravel del usuario: solo lo que instaló o gestionó el panel.
- El instalador de MariaDB inicializa `/var/lib/mysql` en Arch antes de arrancar el servicio,
  se detiene si detecta un MySQL/MariaDB ajeno con datos y no rota la contraseña de
  `valet_studio` cuando la conexión falla. La desinstalación solo para y purga MariaDB si
  consta que la instaló el panel (`/var/lib/valet-studio/mariadb`).

## [0.3.2] — 2026-11-03

### Añadido

- **Configurar MariaDB de forma segura**: nueva tarjeta **MariaDB security** en la pestaña
  **Instalación** (cuando MariaDB está instalado). El botón **Configure securely** abre una
  ventana de terminal del sistema con `sudo mariadb-secure-installation`: la contraseña de
  administrador y las preguntas del asistente se ven y se responden ahí, y la ventana queda
  abierta al terminar mostrando el código de salida. Hasta ahora el paso de instalación solo
  escribía el comando en el registro y nunca se ejecutaba.
- La tarjeta avisa de que el asistente de proyectos Laravel necesita una MariaDB configurada
  para conectarse: con `root` en `unix_socket` (por defecto en Debian/Ubuntu), las migraciones
  fallan con «Access denied» hasta configurar el acceso.

## [0.3.1] — 2026-11-03

### Corregido

- La fila **valet** de **Programs and updates** ofrecía **Upgrade** aunque ya estuviera en la
  última versión (2.4.5). Al pulsarlo, Composer no tenía nada que instalar y el botón volvía
  a aparecer, como si la actualización hubiera fallado. Ahora solo se muestra cuando hay una
  versión nueva, igual que el resto de programas.
- `runUpdate('valet')` ya no acepta una actualización sin versión nueva: responde que está al
  día en vez de ejecutar un `composer global update` que no cambia nada.

### Cambiado

- Icono de la aplicación rediseñado: la V es más grande y está mejor centrada, con degradado
  coral→magenta, brillo interior y una sombra suave. Se regeneraron los nueve tamaños del
  paquete (`build/icons`), `build/icon.png`, `resources/icon.png`, el favicon y el logo de la
  barra lateral.

## [0.3.0] — 2026-11-03

### Añadido

- **Actualización del propio panel**: la pestaña **Instalación** comprueba las releases de
  GitHub, descarga la versión nueva con progreso y la instala tras reiniciar. El `.deb` y
  el `.rpm` piden la contraseña una vez con polkit (`pkexec`); el AppImage se reemplaza a
  sí mismo. La descarga se verifica con el `sha512` de `latest-linux.yml`.
- `npm run release`: compila, completa `latest-linux.yml` con el `.rpm` (que
  electron-builder no genera), calcula `SHA256SUMS` y publica la release con `gh`.
- La pestaña **Instalación** muestra una tarjeta **Valet Studio** con las acciones
  **Check now**, **Download** y **Restart and install**.

### Corregido

- Al cambiar la versión de PHP, el panel ejecutaba `valet use php@X`. Valet 2.4.5 mete el
  argumento tal cual en `php<versión>-fpm`, así que pedía `phpphp@8.5-fpm` y la instalación
  terminaba en «Changing version failed». Ahora se pasa la versión sola (`valet use 8.5`)
  en la instalación y en la pestaña **PHP**, y una prueba fija el formato.
- Si `valet use` falla, Valet deja el PHP-FPM anterior habilitado pero **parado**. El
  instalador guarda qué versión servía, la vuelve a arrancar y restaura la selección
  anterior antes de abortar.
- Los errores que Valet escribe en stdout ya llegan al diagnóstico. Un
  `Apt was unable to install [php8.5-fpm]` se explica con los comandos del PPA de Ondrej
  en vez de un «valet failed» sin pistas.
- La prueba HTTP de extremo a extremo muestra el motivo real cuando se salta (por ejemplo,
  porque la carpeta de prueba ya existe) y el resumen distingue **ok**, **omitido** y
  **fallido** en vez de pintar en verde algo que no se ejecutó.
- Una sola petición de contraseña por instalación: se prefiere `sudo -A` (sudo la recuerda
  unos minutos) y `pkexec` queda como respaldo.
- La carpeta de proyectos rechaza `/`, `/usr`, `/etc`, `/opt`, `/var`, `/root` y sus ramas,
  y el preflight comprueba que se puede escribir antes de tocar nada.
- Se elimina el paso duplicado de preparación de ayudantes.
- La comprobación final de PHP-FPM también existe en dnf y pacman.

## [0.2.2] — 2026-11-02

### Corregido

- La pestaña **Instalación** ya no desborda los márgenes: los comandos de
  «System packages» se parten dentro de su bloque y el bloque nunca empuja el panel
  más allá del ancho de la ventana, también en ventanas estrechas.
- **Un solo botón de instalación**: «Install everything» (o «Repair everything» si Valet
  ya está instalado) instala Valet, PHP 8.5, MariaDB y Node.js cuando el equipo lo
  permite. Se retiran las casillas de extras opcionales y el botón duplicado.

### Cambiado

- La instalación usa siempre **PHP 8.5**. Ya no hay selector de versión en la pestaña
  Instalación; la pestaña **PHP** sigue permitiendo cambiar entre las versiones ya
  instaladas. Si 8.5 no está en los repositorios, el botón se desactiva con el motivo y
  se ofrece **Add Ondrej PPA**. El comando manual de «System packages» también instala 8.5.

## [0.2.1] — 2026-11-01

### Corregido

- La app instalada desde el `.deb` no arrancaba: Electron abortaba con «The SUID
  sandbox helper binary was found, but is not configured correctly». Ubuntu 24.04 y
  posteriores restringen los *user namespaces* sin privilegios y el `postinst` dejaba
  `chrome-sandbox` en `0755` porque el test se ejecutaba como root. Ahora se instala
  siempre en `4755`, también en el `%post` del `.rpm`.
- La ruta de instalación pasa de `/opt/Valet Studio` (con espacio) a
  `/opt/valet-studio`. El sandbox SUID no puede ejecutarse desde una ruta con espacios;
  el `.rpm` ya usaba la ruta sin espacio. El nombre visible sigue siendo **Valet Studio**
  en la entrada de escritorio.
- Al actualizar desde 0.2.0 se retira la alternativa antigua de `update-alternatives`,
  para que `/usr/bin/valet-studio` no quede apuntando a una ruta borrada por dpkg.

## [0.2.0] — 2026-11-01

### Añadido

- **Plan de instalación previo**: la pestaña Instalación muestra, antes de tocar nada, qué
  componentes se van a instalar, configurar u omitir, y cuáles quedan como tarea manual con
  el motivo. El plan se actualiza al cambiar las opciones y la confirmación lo resume.
- **Resumen final de la instalación**: al terminar, una lista verde/roja comprueba Valet,
  `/usr/local/bin/valet`, el Composer aislado, nginx, PHP-FPM, el DNS, MariaDB, Node.js y
  la prueba HTTP. Si algo falla, el paso **Check the final state** termina en rojo sin
  ocultar el resto de comprobaciones.
- **Node.js sin nvm previo**: si marcas Node.js y falta nvm, el panel lo clona desde su
  repositorio oficial en la etiqueta fijada `v0.40.8` y verifica el commit antes de
  ejecutarlo. No ejecuta un instalador remoto y no sobrescribe un `~/.nvm` existente.
- **apt desatendido y tolerante a bloqueos**: las instalaciones usan
  `DEBIAN_FRONTEND=noninteractive`, `--force-confdef`/`--force-confold` para conservar las
  configuraciones existentes, `DPkg::Lock::Timeout=120` para esperar a otro proceso y
  `Acquire::Retries=3` para reintentar la descarga. Los comandos para copiar a mano siguen
  siendo los cortos.
- **Detección real de Apache y de los puertos actuales**: si `ss -p` no muestra el proceso
  porque nginx o Apache corren como root, el diagnóstico cruza el puerto con la configuración
  del servicio. El checkbox de detener Apache ya desbloquea la instalación, y cambiar un solo
  puerto de nginx o Apache deja de fallar por el puerto que se conserva.
- Selector de **PHP 8.3, 8.4 u 8.5** en las opciones de instalación. Instala la versión
  elegida con sus extensiones, omite las que el repositorio no publica (por ejemplo
  `opcache` e `imap` en PHP 8.5) y la deja como predeterminada con `valet use`. Las
  versiones ausentes aparecen desactivadas con el comando del PPA de Ondrej; el panel
  no modifica tus repositorios.
- Extras opcionales en la instalación: **MariaDB** instala `mariadb-server` y
  `mariadb-client`, arranca el servicio y deja `sudo mariadb-secure-installation` como
  comando manual; **Node.js 26** se instala con nvm y queda como versión por defecto solo
  si se marca la casilla. Si falta nvm, el panel lo instala con la etiqueta y el commit
  fijados; si no hay git, gestor de paquetes o red, muestra los comandos.
- Botón **Install everything**, que marca los extras disponibles (MariaDB y Node 26) y
  lanza la instalación completa, y botón **Add Ondrej PPA** para habilitar PHP 8.3/8.4.
  El PPA solo se añade tras confirmarlo; la instalación normal no toca los repositorios.
- Panel **Programas y actualizaciones** en la pestaña **Instalación**: compara lo instalado con
  lo último disponible de PHP, nginx, dnsmasq, Composer, Valet y Node.js, y actualiza por fila.
  Los paquetes del sistema y Composer avisan de que pedirán la contraseña; Valet se actualiza en
  el Composer aislado y vuelve a aplicar el parche de DNS seguro. Lo que el panel no gestiona
  —Valet instalado fuera del panel, Node bajo nvm, una distribución sin gestor compatible— lo
  dice con el comando exacto en vez de ofrecer un botón que fallaría.
- Asistente **Nuevo proyecto** con el instalador oficial de Laravel (`laravel new`):
  starter kit y autenticación, stack de frontend, pruebas, Boost, gestor de Node, Git y
  base de datos. Las preguntas cambian según las respuestas.
- Detección real de capacidades: versión del instalador, flags que admite, extensiones
  `pdo_*` y gestores de Node disponibles. Los motores sin extensión aparecen
  deshabilitados.
- Instalación automática de `laravel/installer` en el Composer aislado si no hay uno
  global, sin tocar el Composer del usuario.
- Base de datos con credenciales por entorno del proceso: el instalador ejecuta las
  migraciones sin que la contraseña aparezca en los argumentos ni en el registro; después
  se escriben en `.env` y los valores no secretos en `.env.example`.
- **Detener** cancela el grupo completo del instalador (Composer, PHP y Node).
- **Eliminar carpeta incompleta** tras un fallo, limitado a la última carpeta creada y con
  comprobaciones para no tocar enlaces de Valet ni sitios registrados.
- Guía de requisitos previos en la pestaña **Instalación**: cada bloqueo muestra su causa,
  el comando exacto para resolverlo y un botón para copiarlo, con **Volver a comprobar**.
- Elevación con alternativa: si falta `pkexec`, el panel usa `/usr/bin/sudo -A` con el
  diálogo de contraseña. La guía solo bloquea cuando no hay ninguna forma de elevar.
- El botón de instalar explica el motivo cuando está deshabilitado.
- Diagnóstico de errores del gestor de paquetes: bloqueo de dpkg, disco lleno, red caída,
  paquete inexistente, conflictos, autenticación cancelada y tiempo agotado.
- Botón **Cancelar** durante una instalación; libera la interfaz.
- Prueba de humo al final de la instalación: crea un sitio temporal, pide su `index.php`
  por HTTP y distingue 502 (PHP-FPM), 404 (nginx) y 000 (nginx caído).
- Instalación manual en distribuciones sin `apt`/`dnf`/`pacman`: si las herramientas ya
  están, el flujo continúa y omite el paso de paquetes. El botón pasa a
  **Continuar con lo instalado**.
- Aviso cuando la versión de PHP del CLI no tiene un PHP-FPM instalado.

### Cambiado

- La fila de **Node.js** gestionada por nvm explica que las actualizaciones siguen siendo
  manuales y muestra los comandos con botón **Copy**. El instalador solo cambia el Node
  por defecto si se marca la opción **Node.js 26**. El mismo bloque de comandos se
  reutiliza en los requisitos previos y en los errores de instalación.
- El proyecto pasa de **Valet Dashboard** a **Valet Studio**: nombre del paquete, binario
  (`valet-studio`), `appId` (`dev.valetstudio.app`), entrada de escritorio, artefactos
  `.deb`/`.rpm`/AppImage y directorios de estado (`~/.valet-studio`,
  `~/.config/valet-studio`, `/etc/valet-studio`). Una instalación de 0.1.0 no se migra
  automáticamente: desinstálala antes de instalar esta versión.
- La interfaz pasa de español a inglés: textos, diálogos, avisos de error del proceso
  principal, guía de requisitos y asistente de proyectos. Los comentarios del código, este
  registro y los mensajes de commit siguen en español.
- En **Programas y actualizaciones**, la fila de Valet se llama `valet` y ofrece siempre
  **Upgrade**: reinstala el paquete en el Composer aislado y vuelve a aplicar el parche de
  DNS seguro aunque la versión instalada ya sea la última. El contador de pendientes solo
  cuenta actualizaciones reales.
- Interfaz más plana: el área de trabajo pierde margen y borde, los radios bajan a
  4–14 px, las filas dejan de ser tarjetas y las acciones de cada fila pasan a estilo
  fantasma. Etiquetas, segmentos y previsualizaciones pierden el borde y usan un fondo
  suave.
- Los estados hover siguen una sola regla: fondos neutros para lo secundario, relleno más
  oscuro para el botón primario y ningún cambio sobre controles deshabilitados. Todos
  comparten la transición `--t` de 120 ms.
- El texto de acento, aviso y verde se calcula por tema para llegar a AA sobre su propio
  tinte: en claro el rojo pasa de 2,8:1 a 4,9:1 y el ámbar de aviso de 3,1:1 a 4,6:1. Los
  grises secundarios del tema Min también suben al mínimo legible.
- El tema Min oscuro usa un azul de relleno (`#0E639C`) en los controles primarios: su
  azul claro no admitía texto blanco, así que el botón llevaba texto negro.
- El tamaño de texto de Configuración escala toda la interfaz. Antes solo crecían los
  títulos: de 100 declaraciones de `font-size`, 89 eran píxeles fijos. Ahora hay cuatro
  tamaños derivados de `--fs`, con suelos para no bajar de 9 px, y las alturas de
  botones, campos, etiquetas y barras salen del mismo valor.
- El espaciado sigue una rejilla de 4 px, con 1 y 2 px reservados para ajustes ópticos, y
  los interlineados bajan de siete valores a tres: títulos, interfaz y texto largo.
- El modo compacto aprieta de verdad: además de filas y paneles, reduce las alturas de
  control y las barras mediante el token `--dense`.
- La sección **Red y DNS** de Instalación explica antes de elegir: qué es el DNS, qué hace
  cada modo, qué toca del sistema y qué riesgo tiene. **Seguro** (dnsmasq propio en
  127.0.0.1:5354 con una ruta en systemd-resolved) y **Hosts** (`/etc/hosts`) se presentan
  como las dos opciones que no tocan la red, y **Clásico** avisa de que puede dejar sin
  WiFi hasta reiniciar. Los modos son tarjetas de opción, con la recomendada marcada, y
  uno no disponible dice el motivo en vez de quedar solo deshabilitado. Las comprobaciones
  del equipo dejan de ser iconos: cada una dice qué se ha encontrado. **Reparar DNS** y
  **Sincronizar hosts** se mudan a esta sección, junto al modo al que afectan.
- La pestaña **Correo** deja de ser una sucesión de tarjetas y pasa a ser un visor. Una
  barra compacta reúne estado, versión, protección y contadores, con los endpoints en dos
  chips de dos líneas que ya no truncan las URLs; debajo, las acciones en su propia fila,
  los avisos en una línea cada uno y la interfaz de Mailpit con una barra de navegador que
  muestra la URL y **Abrir en el navegador**. El visor es cuadrado, porque la vista es una
  superficie nativa que no admite esquinas redondeadas, y crece con la ventana en lugar de
  tener un alto fijo. Se retiran las tarjetas de estadísticas y los avisos duplicados de la
  barra lateral.
- Los controles rellenos (botón **Nuevo proyecto** y segmentos activos) usan un rojo más
  profundo con texto blanco: el rojo de marca sobre fondo oscuro no admitía blanco con
  contraste AA, así que el acento queda para iconos, bordes y texto, y el relleno usa
  `--accent-fill`.
- La creación de proyectos usa `laravel new` en lugar de `composer create-project`. Solo
  se ofrece la última versión estable: el instalador no acepta una restricción.
- Tras crear el proyecto se ajusta `APP_URL` en `.env` con el dominio y el puerto reales
  de nginx, aunque el instalador los hubiera dejado por defecto.
- El paso de dependencias consulta qué falta antes de ejecutar el gestor de paquetes, así
  que «Reparar instalación» termina en segundos cuando todo está instalado.
- Se instala `php-sqlite3` (y `php-process` y `php-pdo` en Fedora), necesario para las
  migraciones de Laravel 11 y posteriores y para `ext-posix` de Valet.
- `valet install` se valida con `nginx -t` antes de continuar.
- Los comandos tienen un tiempo máximo de 15 minutos y el error lo explica.

## [0.1.0] — 2026-10-27

Primera versión publicada. Recoge el panel completo, la integración de Mailpit y
el endurecimiento de seguridad del proceso principal.

### Añadido

- Panel de escritorio en Electron + React para gestionar Valet Linux: sitios,
  puertos, servicios, DNS, certificados y creación de proyectos Laravel.
- Integración de Mailpit: instalar, arrancar, parar, actualizar y abrir la
  interfaz; estado del servidor SMTP y del buzón.
- Configuración de Mailpit por pestañas (SMTP, interfaz, relay, caos, etiquetas,
  webhook), con las opciones avanzadas plegadas y validadas contra `mailpit --help`.
- Integraciones de Mailpit para Laravel (`MAIL_*` en `.env` y `mail.php`) y
  WordPress (constantes de `wp-config.php`).
- Ventana modal compartida (`Modal.tsx`) con foco atrapado, cierre por capas y
  fondo `inert`, usada por los cuatro diálogos de la aplicación.
- Wiki en español: 21 páginas, con la sección de Correo (6 páginas) y 25 capturas.
- Integración continua en GitHub Actions: `typecheck`, pruebas y build en Node;
  `gofmt`, `go vet` y pruebas en Go.
- 47 pruebas de interfaz y proceso principal (rutas seguras, guardas de ventana,
  `htpasswd`, ayudantes de root, configuración de Mailpit, contraste del tema) y
  pruebas Go para Quadlet, servicios y entorno.

### Seguridad

- Política de rutas en el proceso principal: `safe-path.ts` confina las
  operaciones de `uninstall` y de los registros a los directorios permitidos.
- `assertTrusted` valida el remitente de cada mensaje IPC; se añaden guardas
  `will-navigate`, `will-redirect`, `setWindowOpenHandler` y
  `will-attach-webview` en `window-guard.ts`.
- Los secretos dejan de viajar en `argv`: `htpasswd -niB` y `tee` reciben los
  datos por entrada estándar mediante `runInput`.
- Los ayudantes que se ejecutan como root se instalan en
  `/usr/local/libexec/valet-studio` con propietario `root` y modo `0755`.
- `.env` y `php.ini` se escriben con modo `0600`; las unidades Quadlet que
  contienen secretos también, y `HealthCmd` ya no incluye la contraseña.
- `service.Start` guarda la unidad antes de arrancarla para no dejar un servicio
  a medias si falla la escritura.

### Cambiado

- Los atajos de teclado se ignoran mientras hay un diálogo abierto.
- Los rótulos de Mailpit describen lo que la opción hace de verdad
  (`MP_TAG`, `MP_CHAOS_TRIGGERS`, `MP_SMTP_RELAY_MATCHING`, `MP_WEBHOOK_LIMIT`).
- El botón «Usar el del sistema» aparece cuando la instalación gestionada no es
  la que está en uso.
- El color de texto sobre el color de acento se elige por contraste WCAG real.

### Notas

- El `.rpm` se empaqueta con `scripts/build-rpm.sh` y `build/rpm/valet-studio.spec`:
  electron-builder 25 usa fpm 1.9.3, que pasa un `--define buildroot` que rpm 6
  ignora, y cada fichero acaba en «File not found». El payload es el mismo.
- `npm audit` informa de 21 avisos en dependencias de desarrollo (tinypool,
  node-gyp, cacache, tar). No afectan al binario distribuido y no se fuerzan
  porque exigirían subir a `vite` 6, incompatible con `electron-vite` 2.
- Si `htpasswd` no está instalado, la protección de Mailpit sigue funcionando en
  modo texto plano con el fichero en `0600`.

[0.4.0]: https://github.com/LC-jhony/valet-studio/compare/v0.3.2...v0.4.0
[0.2.0]: https://github.com/LC-jhony/valet-studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LC-jhony/valet-studio/releases/tag/v0.1.0
