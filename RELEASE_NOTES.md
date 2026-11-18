# Lair v1.0.0

Primera versión etiquetada de **Lair**: entorno de desarrollo local para **PHP / Laravel nativo**, sin Docker ni máquinas virtuales. Un único binario Go (biblioteca estándar, cero dependencias externas) contiene la CLI, el daemon y el punto de entrada de los shims. Todo se instala bajo una sola raíz (`$LAIR_HOME`, `$XDG_DATA_HOME/lair` o `~/.local/share/lair`) y los servicios corren como el usuario, escuchando solo en `127.0.0.1`.

---

## Novedades por fases

### Fase 1 — Catálogo firmado e instalación atómica

- Catálogo JSON con `schema`, `channel`, `serial`, `generated`, `expires` y paquetes por plataforma.
- Firma **Ed25519** en `.sig` base64; clave pública embebida con `go:embed`. Se rechazan firma inválida, canal distinto, schema desconocido, manifiesto expirado y serial menor.
- Múltiples URLs base de mirrors (`LAIR_MANIFEST_BASE_URLS`) con fallback en orden: la confianza depende de la firma, no del host.
- Caché del manifiesto con refresco en segundo plano tras 6 h y hook `OnChange` para reaccionar a cambios del catálogo.
- Descarga a `.part`, verificación **SHA-256 en streaming**, extracción con `safeJoin` (impide `../`), `Prepare` + `os.Rename` atómicos y marcador de build.
- `installer.Manager` con un job por paquete: fases, progreso, cancelación, logs en `log/<id>-install.log` y hooks `OnSuccess`.
- Builds marcados como *yanked* se rechazan y se reemplazan automáticamente (`Engine.ReplaceYanked`) al detectar una corrección vía `OnChange`.

### Fase 2 — PHP, Composer, Node y shims

- PHP **8.1–8.5 en paralelo** bajo `php/<minor>/`; `php.ini` se crea una vez y se preserva en actualizaciones.
- PHP-FPM por socket unix en `run/`, pool de depuración Xdebug separado y detección de extensiones requeridas desde `composer.json` / `.env`.
- `composer.phar` descargado solo si su SHA-256 coincide con el publicado; se ejecuta con el intérprete PHP correcto. URLs sustituibles por `LAIR_COMPOSER_DOWNLOAD_URL` / `LAIR_COMPOSER_CHECKSUM_URL`.
- Node con builds oficiales y resolución por proyecto: aislado → `.lairrc` (antes `.flockrc`) → `.nvmrc` / `.node-version` → default → más reciente. Alias ambiguos (`lts/*`, `node`, `stable`) se ignoran.
- Prefijo global de npm por major (`node/global/<major>/`) para que los paquetes globales sobrevivan a actualizaciones patch.
- Shims en `bin/` para `php`, `php-fpm`, `composer`, `node`, `npm`, `npx` y clientes de servicios. `lair exec` (oculto) usa `execve`, sin proceso intermediario.
- Perfiles bash, zsh, fish y `environment.d` idempotentes y reversibles, delimitados por `# >>> lair >>>` / `# <<< lair <<<`.

### Fase 3 — Servicios, supervisor y plataforma

- Specs puros para PostgreSQL 14–18, MySQL, MariaDB, MongoDB, Valkey/Redis, Meilisearch, Typesense y RustFS, con argumentos, entorno, init de datos, clientes y snippet para `.env`.
- Una sola versión activa por puerto; detección de conflictos con sugerencia de puerto alternativo. Validación adicional en MySQL/MariaDB para impedir que un config externo cambie bind, puerto o socket.
- Datos separados por “línea” (`services/<id>/data/<línea>/`; PostgreSQL usa el major) y conservados al cambiar de versión salvo `--delete-data`.
- Supervisor con backoff exponencial (1 s → 60 s), estado por servicio, cola de logs y señales al grupo de procesos. Sin deadlock al registrar logs.
- Plan privilegiado revisable: unidad `lair@<usuario>.service` (`User=%i`, `CAP_NET_BIND_SERVICE`, `NoNewPrivileges=yes`), regla polkit, drop-in de `systemd-resolved` (`DNS=127.0.0.1#53535`, `Domains=~test`) y helpers de CA con `--add` / `--remove`.
- Reversión completa con `revert-privileged.sh`; los scripts se conservan en `$HOME` si se usa `--delete-data`.

### Fase 4 — Daemon, DNS, HTTPS y CLI

- API local en unix socket con token de 256 bits (`0600`, comparación en tiempo constante). `internal/daemon/protocol.go` es la fuente única de acciones y payloads.
- DNS UDP propio en `127.0.0.1:53535`: responde `*.test` y reenvía el resto al upstream de `/etc/resolv.conf`.
- CA ECDSA P-256 local, certificados por sitio con SAN wildcard y soporte de confianza en sistema y navegadores.
- Capa web propia con `net/http`, TLS dinámico, router por Host, archivos estáticos en `public/` y cliente FastCGI mínimo hacia PHP-FPM (sin binario proxy externo).
- `Engine` concentra la lógica compartida: instalación, sitios, exec, bootstrap, reemplazo de yanked y supervisión. Daemon y CLI son dos frentes del mismo motor; modo offline disponible.
- CLI completa: `install`, `uninstall`, `status`, `restart`, `update`, `php`, `node`, `services`, `park`, `link`, `unlink`, `secure`, `pin`, `isolate`, `logs`, `daemon`, `doctor` y `exec` oculto.
- Flags del daemon: `--foreground`, `--no-web`, `--no-dns`, `--no-api`, `--dns-port`, `--http-port`, `--https-port` y `--domain`.

---

## Correcciones incluidas

- **`node -v` / `npm -v` no reconocidos:** `Bootstrap` ahora crea shims y PATH **antes** de descargar Composer. Composer y la CA son *best-effort* (avisos, no abortan), con timeout de 45 s. Cualquier `lair ... install` regenera shims y PATH al terminar.
- **Nuevo `lair doctor`:** diagnostica PATH, shims faltantes y versiones instaladas; imprime el `export PATH=...` exacto para la terminal actual.
- **`lair uninstall`:** `revert-privileged.sh` ya no reinstala la CA; invoca `<LAIR_HOME>/trust-ca.sh --remove` y `trust-ca-user.sh --remove`, con reversión NSS incluida.
- **Nombre del proyecto:** se consolidó `lair` en módulo Go (`github.com/lair-sh/lair`), binario, rutas, documentación y mensajes. Los restos del nombre anterior se renombraron a `.lairrc` y `lair.json`, manteniendo **compatibilidad**: `.flockrc` y `flock.json` siguen leyéndose, `.lairrc` tiene prioridad y el primer `lair pin` migra el contenido sin borrar el archivo antiguo.
- Referencias al antiguo diseño “Caddy embebido” actualizadas a “capa web embebida”.

---

## Documentación

- `README.md` reenfocado en **compilación/Makefile, configuración y uso del comando `lair`**: quick start, los 7 targets del Makefile, cross-compilación, precedencia de `LAIR_HOME`, `config.json`, `.lairrc`, variables de entorno, perfiles, scripts privilegiados, referencia de comandos y flujos prácticos (Laravel nuevo, dos proyectos con PHP distinto, cambio de BD, instalación sin red), además de un mapa de módulos y troubleshooting.
- `docs/CLI.md`, `docs/ARCHITECTURE.md`, `docs/PHASES.md` y `docs/SECURITY.md` actualizados con `doctor`, las nuevas variables y el renombrado compatible.

---

## Verificación

- `gofmt -l .`: sin salida.
- `go vet ./...`: sin hallazgos.
- `go test ./...`: todos los paquetes en `ok`, incluidos los tests de regresión de shims, bootstrap resiliente, doctor, reversiones de uninstall, dispatcher, yanked y compatibilidad `.flockrc` / `flock.json`.
- `go build ./...` y `go build -o lair ./cmd/lair`: correctos.
- Smoke tests: `lair status` offline, daemon en foreground, `node -v` → `v22.11.0` y `npm -v` → `10.9.0` a través del shim con PATH configurado, e `install` con red bloqueada creando los 17 shims y avisando de Composer.

> `go test -race` requiere `gcc`/cgo y no estaba disponible en el entorno de compilación; no bloquea esta versión.

---

## Seguridad

- La clave `keys/private.ed25519` es **solo de desarrollo** y no se versiona ni se embebe; se excluye mediante `.gitignore`.
- `certs/ca-key.pem` permite emitir certificados válidos en todo el sistema si la CA está instalada: trátala como secreto.
- Los scripts privilegiados no se ejecutan automáticamente: el usuario los revisa y los lanza con `sudo`.
- No hay sandbox: los servicios son procesos normales del usuario. El DNS propio es UDP mínimo sin DNSSEC.

---

## Instalación rápida

```sh
export PATH="$HOME/.local/go/bin:$PATH"
cd lair && make build
./lair install
sudo "$LAIR_HOME/setup-privileged.sh"
sudo "$LAIR_HOME/trust-ca.sh" --add
sudo systemctl enable --now lair@$USER
# abre una terminal nueva
lair php install 8.4 && lair php use 8.4
lair node install 22 && lair node default 22
node -v && npm -v && php -v && lair doctor
```

---

## Publicación del release

Lair se publica en el repositorio existente **`LC-jhony/valet-deck`**, reemplazando el contenido anterior con un commit de reemplazo que conserva ambos historiales. La rama `main`, el tag anotado `v1.0.0` y estas notas están preparados localmente; para publicarlos con credenciales de GitHub:

```sh
cd /home/jhony/Documentos/valet-deck
git push origin main
git push origin v1.0.0
gh release create v1.0.0 --repo LC-jhony/valet-deck --title "Lair v1.0.0" --notes-file RELEASE_NOTES.md
```
