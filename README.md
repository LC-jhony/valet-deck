# Lair

Entorno de desarrollo local para **PHP / Laravel nativo** (sin Docker ni VM). Un solo binario Go reúne la CLI, el daemon y el punto de entrada de los shims: compilas una vez, configuras con dos variables y usas `lair` para todo.

> Estado: fases 1–4 implementadas y testeadas. Linux con `systemd-resolved` es la plataforma completa. La clave Ed25519 incluida es **de desarrollo**; no sirve para producción.

---

## En 30 segundos

```sh
# 1. compilar
export PATH="$HOME/.local/go/bin:$PATH"
cd lair && make build

# 2. configurar e instalar
export LAIR_HOME="$HOME/.local/share/lair"      # opcional: es el valor por defecto
./lair install
sudo "$LAIR_HOME/setup-privileged.sh"
sudo "$LAIR_HOME/trust-ca.sh" --add
sudo systemctl enable --now lair@$USER

# 3. usar
new shell                       # o: source ~/.bashrc
lair php install 8.4 && lair php use 8.4
lair node install 22 && lair node default 22
lair services install postgres 17
node -v && npm -v && php -v
lair doctor                     # diagnóstico si algo no responde
```

---

## Índice

1. [Compilación y Makefile](#1-compilación-y-makefile)
2. [Configuración](#2-configuración)
3. [El comando `lair`](#3-el-comando-lair)
4. [Flujos de trabajo](#4-flujos-de-trabajo)
5. [Resolución de versiones](#5-resolución-de-versiones)
6. [Estructura de datos](#6-estructura-de-datos)
7. [Mapa de módulos](#7-mapa-de-módulos)
8. [Daemon, DNS y HTTPS](#8-daemon-dns-y-https)
9. [Seguridad](#9-seguridad)
10. [Solución de problemas](#10-solución-de-problemas)
11. [Más documentación](#11-más-documentación)

---

## 1. Compilación y Makefile

### Requisitos de compilación

Lo único que necesitas para **compilar** es Go 1.21+ (en este entorno: `~/.local/go`, versión 1.27.4). El módulo usa exclusivamente la biblioteca estándar: **no hay `go.mod` con dependencias externas**, no hay `go get`, no hay que descargar librerías. El usuario final no necesita Go: recibe el binario ya compilado.

Si Go está instalado en `~/.local/go`, añádelo al PATH de tu shell:

```sh
export PATH="$HOME/.local/go/bin:$PATH"
go version        # go version go1.27.4 linux/amd64
```

### El Makefile

```makefile
GO  ?= go
BIN := lair

all: test build
build:      $(GO) build -o $(BIN) ./cmd/lair
test:       $(GO) test ./...
test-race:  $(GO) test -race ./...
fmt:        $(GO) fmt ./...
vet:        $(GO) vet ./...
clean:      rm -f $(BIN)
```

| Target | Comando que ejecuta | Para qué sirve |
|---|---|---|
| `make build` | `go build -o lair ./cmd/lair` | Genera `./lair`: CLI + daemon + `exec` en un único ejecutable. Es el target que normalmente usarás. |
| `make test` | `go test ./...` | Toda la suite unitaria (manifiesto, versiones, extracción segura, servicios, shims, API, DNS, PKI, web, dispatcher, bootstrap, uninstall). |
| `make vet` | `go vet ./...` | Análisis estático; debe salir sin mensajes. |
| `make fmt` | `go fmt ./...` | Formatea todo el código con `gofmt`. |
| `make test-race` | `go test -race ./...` | Detecta carreras; **requiere cgo y un compilador C (`gcc`)**. Si no tienes gcc, usa `make test`. |
| `make all` | `test` + `build` | Valida y compila de un golpe (es el target por defecto: basta con `make`). |
| `make clean` | `rm -f lair` | Borra el binario generado. |

### Personalizar la compilación

Las variables se pueden sobreescribir en la línea de comandos:

```sh
make GO="$HOME/.local/go/bin/go" BIN=./lair-dev build     # ruta explícita de Go / otro nombre
make GO=go test                                           # usar el go del PATH
make clean build                                          # reconstruir desde cero
```

Cross-compilación (el manifiesto usa claves `linux-x64`, `linux-arm64`, etc.):

```sh
GOOS=linux   GOARCH=amd64 make build BIN=./lair-linux-x64
GOOS=linux   GOARCH=arm64 make build BIN=./lair-linux-arm64
GOOS=darwin  GOARCH=arm64 make build BIN=./lair-darwin-arm64
CGO_ENABLED=0 make build      # binario estático; recomendado para distribuir
```

Tras compilar, comprueba el binario:

```sh
./lair help
./lair status --json
```

> Instala el binario en una ruta **estable** (por ejemplo `~/.local/bin/lair`). Los shims guardan la ruta absoluta del ejecutable con el que se generaron: si luego borras el binario temporal con el que hiciste `lair install`, los shims dejarán de funcionar. Si eso pasa, vuelve a ejecutar `lair install` con el binario definitivo.

---

## 2. Configuración

### 2.1 Raíz de datos (`LAIR_HOME` / `XDG_DATA_HOME`)

Todo lo que Lair gestiona vive bajo una sola raíz. La precedencia es:

| Prioridad | Variable | Resultado |
|---|---|---|
| 1 | `LAIR_HOME` | Se usa tal cual (si es relativa, se convierte en absoluta). |
| 2 | `XDG_DATA_HOME` | `$XDG_DATA_HOME/lair` |
| 3 | — | `~/.local/share/lair` |

```sh
export LAIR_HOME="$HOME/.local/share/lair"     # valor por defecto; puedes omitirlo
export LAIR_HOME="/datos/lair"                  # raíz alternativa (disco, tests, etc.)
export XDG_DATA_HOME="$HOME/.local/share"       # equivalente estándar XDG
```

Comprueba la raíz que se está usando en cualquier momento:

```sh
lair status    # primera línea: "Lair home: ..."
lair doctor    # imprime home, bin, PATH y shims
```

### 2.2 Configuración persistente (`config.json`)

`<LAIR_HOME>/config.json` (permisos `0600`) es el estado de la instalación. **En producción solo lo escribe el daemon**; la CLI lo usa directamente únicamente en modo offline/bootstrap. Las escrituras son atómicas.

```json
{
  "version": 1,
  "installed": {
    "php/8.4": "N3",
    "node/22.11.0": "N1",
    "postgres/17.2": "N2"
  },
  "defaults": {
    "php": "8.4",
    "node": "22.11.0",
    "postgres": "17.2"
  },
  "ports": { "postgres": 5432 },
  "sites": {
    "mi-app.test": {
      "path": "/home/usuario/proyectos/mi-app",
      "php": "8.4",
      "node": "22"
    }
  }
}
```

| Campo | Significado | Se modifica con |
|---|---|---|
| `installed` | `"<paquete>/<versión>" → build` instalado. | `lair php/node/services install` |
| `defaults` | Versión activa de `php`, `node` y cada servicio. | `lair php use`, `lair node default`, `lair services use` |
| `ports` | Puerto asignado a cada servicio (uno activo por puerto). | `lair services install --port N` |
| `sites` | Sitios aparcados y sus versiones aisladas. | `lair park`, `lair link`, `lair isolate` |

`config.json` no se edita a mano: usa los comandos para que el daemon mantenga el estado coherente.

### 2.3 Configuración por proyecto (`.lairrc`)

`.lairrc` es un archivo de **texto versionable** que fija versiones para un proyecto. Se escribe con `lair pin` y lo lee el shim antes de elegir versión:

```ini
# .lairrc
php=8.4
node=22
```

```sh
lair pin php 8.4
lair pin node 22
git add .lairrc && git commit -m "Fijar versiones de Lair"
```

> **Compatibilidad:** los proyectos que todavía tengan `.flockrc` (nombre del diseño original) siguen funcionando: se lee como alternativa, tiene menos prioridad que `.lairrc`, y el primer `lair pin` migra su contenido al archivo nuevo sin borrar el antiguo. Lo mismo ocurre con el marcador `flock.json` de instalaciones PHP antiguas, que ahora se escribe como `lair.json`.

También se respetan `.nvmrc` y `.node-version` para Node (en ese orden, después de `.lairrc`). Los alias ambiguos como `lts/*` o `node` se ignoran deliberadamente. Para fijar una versión solo en un sitio aparcado, sin versionarla, usa `lair isolate php 8.3` (o `lair isolate php --off` para quitarla).

### 2.4 Variables de entorno

| Variable | Uso |
|---|---|
| `LAIR_HOME` | Raíz de datos (ver 2.1). |
| `XDG_DATA_HOME` | Base alternativa (`$XDG_DATA_HOME/lair`). |
| `LAIR_MANIFEST_BASE_URLS` | Mirrors del catálogo firmado separados por comas; se prueban en orden. La confianza es de la firma, no del host. |
| `LAIR_COMPOSER_DOWNLOAD_URL` | URL alternativa de `composer.phar` (se sigue verificando el SHA-256). |
| `LAIR_COMPOSER_CHECKSUM_URL` | URL alternativa del `.sha256` de Composer. |

Las dos últimas son útiles en entornos cerrados o con mirror interno:

```sh
export LAIR_MANIFEST_BASE_URLS="https://cdn.lair.sh/stable,https://mirror.interno/lair/stable"
export LAIR_COMPOSER_DOWNLOAD_URL="https://mirror.interno/composer.phar"
export LAIR_COMPOSER_CHECKSUM_URL="https://mirror.interno/composer.phar.sha256"
lair update && lair install
```

### 2.5 PATH y perfiles de shell

`lair install` escribe un bloque delimitado por `# >>> lair >>>` / `# <<< lair <<<` en:

- `~/.bashrc` y `~/.zshrc` (guarda `[ -d "$bin" ]` para no contaminar PATH si se borra la raíz);
- `~/.config/fish/conf.d/lair.fish`;
- `~/.config/environment.d/lair.conf`.

Es idempotente y reversible: `lair uninstall` elimina exactamente esos bloques y respeta cualquier otra edición tuya. Para aplicarlo sin reiniciar:

```sh
source ~/.bashrc     # bash
source ~/.zshrc      # zsh
```

Si `node -v` no se reconoce, ejecuta `lair doctor`: te dirá si falta el PATH y te imprimirá el `export PATH="..."` exacto.

### 2.6 Scripts privilegiados (configuración del sistema)

`lair install` genera tres scripts que **tú debes revisar y ejecutar una vez**; Lair nunca los lanza automáticamente:

| Script | Se ejecuta con | Qué configura |
|---|---|---|
| `<LAIR_HOME>/setup-privileged.sh` | `sudo` | Unidad `lair@<usuario>.service`, regla polkit y drop-in de `systemd-resolved` (`DNS=127.0.0.1#53535`, `Domains=~test`). |
| `<LAIR_HOME>/trust-ca.sh --add` | `sudo` | CA local en el store del sistema. |
| `<LAIR_HOME>/trust-ca-user.sh --add` | tu usuario | CA en Firefox/Chromium (requiere `certutil`). |

```sh
sudo "$LAIR_HOME/setup-privileged.sh"
sudo "$LAIR_HOME/trust-ca.sh" --add
"$LAIR_HOME/trust-ca-user.sh" --add
sudo systemctl enable --now lair@$USER
```

`lair uninstall` genera `revert-privileged.sh` (y conserva los helpers con `--remove`) para deshacer todo. Con `--delete-data`, los scripts de reversión se guardan en `$HOME` para que no desaparezcan al borrar la raíz.

---

## 3. El comando `lair`

El binario es la **única** entrada: `lair <comando> [subcomando] [args] [flags]`. Si el daemon está activo, la CLI habla con él por un socket unix; si no, usa el mismo motor en proceso (modo offline). No hay dos implementaciones de la lógica.

### 3.1 Instalación y diagnóstico

| Comando | Descripción |
|---|---|
| `lair install` | Bootstrap local (shims, PATH, CA, Composer verificado) y generación de los scripts privilegiados. |
| `lair uninstall [--delete-data]` | Revierte perfiles/shims y genera la reversión. Los datos se conservan salvo `--delete-data`. |
| `lair status [--json]` | Muestra home, estado del daemon, PHP, Node, servicios, puertos, sitios y jobs. `--json` para scripts. |
| `lair doctor` | Comprueba PATH, shims y versiones; imprime cómo arreglarlo. **Primer comando si algo no responde.** |
| `lair restart` | Reinicia todos los servicios supervisados activos. |
| `lair update` | Fuerza el refresco del catálogo firmado. |
| `lair logs [nombre]` | Muestra un log (`postgres`, `node-22-install`, ...) o lista los disponibles si no hay argumento. |
| `lair help` | Ayuda en pantalla. |

### 3.2 PHP

| Comando | Descripción |
|---|---|
| `lair php list` | Versiones instaladas; `*` marca la default. |
| `lair php install [versión]` | Instala una línea minor (`8.4`) o versión exacta. Sin versión, instala la más reciente del catálogo. |
| `lair php use <minor>` | Cambia la default global. |

```sh
lair php install 8.3
lair php install 8.4 && lair php use 8.4
php -v && composer -V
```

### 3.3 Node

| Comando | Descripción |
|---|---|
| `lair node list` | Versiones instaladas; `*` marca la default. |
| `lair node install [versión]` | Instala `22`, `22.11.0` o la última. Regenera los shims al terminar. |
| `lair node default <versión>` | Fija la default (acepta major, p. ej. `22`). |

```sh
lair node install 22 && lair node default 22
node -v && npm -v && npx --version
```

> Si `node -v` falla justo después de instalar, es un problema de PATH/shims, no de la instalación. Ver [solución](#10-solución-de-problemas).

### 3.4 Servicios

Forma general: `lair services <acción> <id> [versión] [flags]`.

| Acción | Ejemplo | Descripción |
|---|---|---|
| `list` (o sin acción) | `lair services list` | Estado de todos los servicios. |
| `install` | `lair services install postgres 17 --port 5432` | Descarga e inicializa; no cambia la activa si ya hay una. |
| `use` | `lair services use postgres 17.2` | Cambia la versión activa conservando los datos. |
| `update` | `lair services update postgres` | Instala la última, activa y reinicia. |
| `uninstall` | `lair services uninstall postgres 17.2 --delete-data` | Elimina la instalación; sin `--delete-data` conserva los datos. |
| `create-db` | `lair services create-db postgres laravel` | Crea una base de datos. |
| `restart` / `stop` | `lair services restart postgres` | Controla el supervisor. |

IDs disponibles: `postgres`, `mysql`, `mariadb`, `mongodb`, `redis`, `valkey`, `meilisearch`, `typesense`, `rustfs`.

Los clientes (`psql`, `mysql`, `redis-cli`, `mongosh`, ...) también son shims e inyectan automáticamente host, puerto y usuario del servicio activo:

```sh
lair services install postgres 17
lair services create-db postgres laravel
psql -d laravel            # apunta a 127.0.0.1:5432 sin configurar nada
```

### 3.5 Sitios y HTTPS

| Comando | Descripción |
|---|---|
| `lair park` | Registra el directorio actual como `<nombre>.test`. |
| `lair link <nombre> [ruta]` | Registra un sitio con host explícito (por defecto, el directorio actual). |
| `lair unlink <nombre>` | Quita el sitio del router sin borrar sus archivos. |
| `lair secure [nombre]` | Emite certificado para el sitio y su wildcard con la CA local. Sin nombre, detecta el sitio del directorio actual. |
| `lair isolate php\|node <versión\|--off>` | Fija o quita una versión solo para ese sitio (config.json, prioridad máxima). |

```sh
cd ~/proyectos/mi-app
lair park                  # https://mi-app.test
lair secure mi-app.test
lair isolate php 8.3       # este sitio usa 8.3 aunque la default sea 8.4
lair isolate php --off
```

### 3.6 Pines de proyecto

```sh
lair pin php 8.4           # escribe php=8.4 en .lairrc del directorio actual
lair pin node 22           # añade node=22
```

### 3.7 Daemon

```sh
lair daemon --foreground   # primer plano, para desarrollo
```

Flags: `--no-web`, `--no-dns`, `--no-api`, `--dns-port`, `--http-port`, `--https-port`, `--domain`. Sin `--foreground`, implica que el daemon lo gestiona systemd (`lair@<usuario>.service`).

```sh
lair daemon --foreground --no-web --no-dns
```

### 3.8 `exec` (interno, no lo llames a mano)

Cada shim contiene `exec "<lair>" exec <tool> "$@"`. El subcomando oculto `exec` resuelve la versión para el directorio actual y usa `execve`, sin proceso intermediario. Si falta la versión y hay TTY, ofrece instalarla; desde un script, falla con un mensaje claro. Es la pieza que hace que `node`, `php` y `psql` "simplemente funcionen".

---

## 4. Flujos de trabajo

### 4.1 Proyecto Laravel nuevo

```sh
make build
./lair install
sudo "$LAIR_HOME/setup-privileged.sh"
sudo "$LAIR_HOME/trust-ca.sh" --add
sudo systemctl enable --now lair@$USER

lair php install 8.4 && lair php use 8.4
lair node install 22 && lair node default 22
lair services install postgres 17
lair services create-db postgres laravel

cd ~/proyectos/mi-app
lair pin php 8.4 && lair pin node 22
lair park && lair secure mi-app.test

php -v && composer -V && node -v && npm -v
lair doctor
```

### 4.2 Dos proyectos con PHP distinto

```sh
cd ~/proyectos/legacy && lair pin php 8.1 && php -v   # 8.1
cd ~/proyectos/nuevo  && lair pin php 8.4 && php -v   # 8.4
```

### 4.3 Cambiar de versión de base de datos sin perder datos

```sh
lair services install postgres 18      # instala, no activa
lair services use postgres 18          # activa; los datos se conservan
lair services restart postgres
```

### 4.4 Instalación sin red

```sh
lair install                  # crea shims y PATH; Composer avisa pero no aborta
lair status                   # las versiones ya instaladas siguen funcionando
lair doctor                   # verifica que PATH y shims estén bien
```

---

## 5. Resolución de versiones

El shim elige versión con esta precedencia (de mayor a menor prioridad):

| Herramienta | Orden |
|---|---|
| PHP | `isolate` (sitio) → `.lairrc` (`php=`, antes `.flockrc`) → default global → última instalada |
| Node | `isolate` → `.lairrc` (`node=`, antes `.flockrc`) → `.nvmrc` → `.node-version` → default global → última instalada |
| Servicios | `defaults[id]` del `config.json` (una versión activa por puerto) |

`version.ExactOrLatest` acepta `22` (última de la major), `22.11.0` (exacta o última de la major) y `8.4` (última de la minor).

---

## 6. Estructura de datos

```
<LAIR_HOME>/
├── bin/                     shims ejecutables (0755) y binario lair
├── tools/                   composer.phar verificado
├── php/<minor>/             bin/, sbin/php-fpm, etc/php.ini, etc/pool.d/, run/, lair.json
├── node/<version>/bin/      node, npm, npx
├── node/global/<major>/     prefijo global de npm por major
├── services/<id>/<version>-build<N>/    binarios
├── services/<id>/data/<línea>/          datos (postgres usa el major)
├── log/                     logs de instalación y servicios
├── run/                     sockets unix y token de la API (0700)
├── certs/                   CA, clave (0600) y certificados por sitio
├── cache/binaries/          caché de artifacts
├── config.json              estado persistente (solo daemon)
├── setup-privileged.sh / trust-ca.sh / trust-ca-user.sh / revert-privileged.sh
```

---

## 7. Mapa de módulos

La lógica compartida está en `internal/engine`; el daemon y la CLI son dos frentes del mismo motor. Detalle completo en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| Paquete | Responsabilidad | API principal |
|---|---|---|
| `cmd/lair` | Único `main`: CLI, daemon y `exec`. | `main()` |
| `app` | Rutas e identidad. | `Resolve()`, `Platform()` |
| `assets` | Clave pública y logos embebidos (`go:embed`). | `PublicKey()` |
| `version` | Parser semver y resolución. | `Parse`, `ExactOrLatest` |
| `manifest` | Catálogo firmado, serial, caché 6 h, `OnChange`. | `Catalog.Refresh/Subscribe`, `Verify` |
| `download` + `installer` | Descarga `.part`, SHA-256, `safeJoin`, jobs. | `Manager.Start`, `Job.Status/Cancel` |
| `config` | Store atómico de `config.json`. | `Store.Update/View` |
| `php` | Versiones paralelas, php.ini, FPM, Xdebug. | `EnsureINI`, `WriteFPM`, `Env` |
| `composer` | Phar verificado por SHA-256. | `Installer.Ensure`, `Command` |
| `node` | Builds oficiales, resolución, prefijo npm. | `ResolveVersion`, `Env` |
| `shims` | Wrappers y perfiles reversibles. | `Generate`, `EnsureProfiles` |
| `services` | Specs puros, datos, puertos. | `Build`, `DataPath`, `CheckPort` |
| `supervisor` | Backoff, logs, grupos de procesos. | `Supervisor.Run/Update` |
| `platform` | systemd, polkit, resolved, CA, plan privilegiado. | `BuildPlan`, `InstallTrust` |
| `dns` / `pki` / `fastcgi` / `web` | `*.test`, TLS local, FPM, router HTTP. | `Server`, `IssueSite`, `Router.Match` |
| `daemon` | API unix+token y protocolo de acciones. | `Server`, `Client`, `Dispatcher`, `Runtime` |
| `engine` | Orquestación compartida. | `InstallPHP/Node/Service`, `Status`, `ResolveTool`, `Bootstrap` |
| `cli` | Comandos, modo offline, `exec`, `doctor`. | `Run`, `runExec` |

---

## 8. Daemon, DNS y HTTPS

```
mi-app.test
  → systemd-resolved (Domains=~test)
  → DNS Lair 127.0.0.1:53535 → 127.0.0.1
  → web.Server 80/443 (TLS con la CA local)
  → Router.Match(Host)
  → estáticos en public/   OR   FastCGI → socket de PHP-FPM
```

| Componente | Dirección |
|---|---|
| API local | `run/api.sock` + `run/api.token` (`0600`) |
| DNS `*.test` | `127.0.0.1:53535` |
| HTTP / HTTPS | `127.0.0.1:80` / `127.0.0.1:443` |

El daemon no corre como root: usa `CAP_NET_BIND_SERVICE` y `NoNewPrivileges=yes`. Los servicios se ejecutan como el usuario y solo escuchan en loopback.

---

## 9. Seguridad

- La confianza de los binarios depende **solo de la firma Ed25519** embebida, nunca del mirror.
- Descarga a `.part` + SHA-256 en streaming + `safeJoin`; builds *yanked* rechazados y reemplazados automáticamente.
- `run/` es `0700`, el token de la API `0600` y se compara en tiempo constante.
- `certs/ca-key.pem` permite emitir certificados válidos en **todo el sistema** si la CA está instalada: trátalo como secreto.
- Los scripts privilegiados no se ejecutan automáticamente; el usuario los revisa y los lanza con `sudo`.
- No hay sandbox: los servicios son procesos normales del usuario. Detalle en [`docs/SECURITY.md`](docs/SECURITY.md).

---

## 10. Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `node: command not found` tras `lair node install` | Shims/PATH no configurados. | `lair doctor` → si faltan, `lair install` → abrir terminal nueva o `source ~/.bashrc`. |
| `npm` usa otro Node | Otra versión antes en PATH. | `echo $PATH`: `<LAIR_HOME>/bin` debe ir primero. |
| `lair install` tarda mucho | Composer sin red. | Ya no bloquea: crea los shims primero y avisa. Reintenta con red. |
| Shims apuntan a un binario borrado | `lair install` se hizo con un binario temporal. | Instala `lair` en ruta estable y vuelve a ejecutar `lair install`. |
| `permission denied` en 80/443 | Falta la unidad o hay conflicto de puerto. | Ejecuta `setup-privileged.sh`; prueba `lair daemon --foreground` para ver el aviso. |
| `*.test` no resuelve | Drop-in de resolved no aplicado. | `sudo "$LAIR_HOME/setup-privileged.sh"` y `resolvectl status | grep ~test`. |
| Certificado no confiable | Falta confianza en navegador. | `"$LAIR_HOME/trust-ca-user.sh" --add` y reinicia el navegador. |
| `no catalog loaded` | Sin caché y sin red. | `lair update` con red; lo ya instalado sigue funcionando offline. |
| `make test-race` falla | Falta `gcc`/cgo. | Usa `make test`. |

---

## 11. Más documentación

- [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — changelog detallado de la versión `v1.0.0`.
- [`docs/CLI.md`](docs/CLI.md) — referencia completa de comandos y variables de entorno.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — interfaces y flujos internos.
- [`docs/PHASES.md`](docs/PHASES.md) — decisiones por fase de implementación.
- [`docs/SECURITY.md`](docs/SECURITY.md) — nota de riesgos y superficie privilegiada.

Logos: `assets/logo-dark.svg` (contenedor negro, L roja degradada) y `assets/logo-light.svg` (contenedor blanco, L negra), con copias embebidas en `internal/assets/` para `go:embed`.
