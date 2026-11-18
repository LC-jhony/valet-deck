# Notas por fases

## Fase 1 — Catálogo y descarga verificada

- `internal/manifest`: manifiesto `schema/channel/serial/generated/expires/packages`, `.sig` base64, clave pública embebida, rechazo de firma inválida, canal distinto, esquema desconocido, expirado y serial menor por canal.
- `internal/download`: URLs base con fallback, descarga a `.part`, SHA-256 en streaming, extracción con `safeJoin` y verificación de ejecutables esperados.
- `internal/installer`: un job por id, fases `downloading`/`installing`, progreso, cancelación, logs y hook `OnSuccess`.
- Builds *yanked* no se ofrecen en `Versions()` ni se instalan; `NeedsReplacement` detecta el build corregido.

Tests: verificación de manifiesto, resolución de versiones, extracción segura.

## Fase 2 — PHP, Composer, Node y shims

- PHP 8.1–8.5 en paralelo bajo `php/<minor>/`; `php.ini` se preserva si ya existe; FPM por socket unix; Xdebug en pool separado; marcador `lair.json` (se sigue leyendo el legacy `flock.json`).
- Composer: `composer.phar` se acepta solo si su SHA-256 coincide con `getcomposer.org/.../composer.phar.sha256`. Se ejecuta siempre como `<php> tools/composer.phar ...` con `argv[0]` absoluto.
- Node: builds oficiales por manifiesto; resolución `isolated > .lairrc (legacy .flockrc) > .nvmrc/.node-version > default > newest`; prefijo global de npm por major.
- Shims: `exec "<binario>" exec <tool> "$@"`; perfiles bash/zsh/fish/`environment.d` con marcadores idempotentes y reversibles.

Tests: resolución de PHP/Node, verificación de Composer, generación de perfiles y shims.

## Fase 3 — Servicios y supervisor

- Specs para PostgreSQL 14–18, MySQL, MariaDB, MongoDB, Valkey/Redis, Meilisearch, Typesense y RustFS. Todos escuchan en `127.0.0.1`; MySQL/MariaDB validan `mysqld-auto.cnf` para impedir que un config externo mueva el puerto o el bind.
- Datos en `services/<id>/data/<línea>/`; PostgreSQL separa por major. Conservación por defecto; `--delete-data` es explícito.
- `create-db` y clients shimeados (`psql`, `mysql`, `redis-cli`, ...).
- Supervisor: backoff exponencial, último error, cola de log de 50 líneas, comparación de Specs, parada limpia y señales al grupo de procesos.

Nota: se corrigió un deadlock en `Supervisor.Run`: registraba logs llamando a `RecordLog` con el mutex ya tomado; ahora usa `appendTail` inline.

Tests: Specs de servicios, init de datos, puertos, supervisor con runner falso.

## Fase 4 — Daemon, DNS y HTTPS

- `internal/daemon`: API JSON sobre socket unix con token `0600`; acciones tipadas en `protocol.go`; `Runtime` arranca API + DNS + web + supervisores y atiende señales.
- `internal/dns`: DNS UDP en `127.0.0.1:53535`; responde A/AAAA para `*.test` y reenvía el resto a los nameservers de `/etc/resolv.conf`.
- `internal/pki`: CA ECDSA P-256 de 10 años con clave `0600`; certificados por sitio con SANs base + wildcard.
- `internal/web`: router por Host (incluye subdominios), archivos estáticos en `public/`, proxy FastCGI, TLS dinámico y detección de conflictos en 80/443.
- `internal/fastcgi`: cliente mínimo RESPONDER sobre unix socket.
- `internal/platform`: unidad `lair@<usuario>.service`, regla polkit solo para la unidad propia, drop-in de `systemd-resolved`, trust store y plan privilegiado renderizado como script único.
- `internal/cli`: todos los comandos requeridos, modo daemon/offline, `exec` oculto con prompt TTY y render de los scripts de privilegios/reversión.

Tests: API con token (incluye rechazo de unauthorized), DNS codec/servidor, PKI, FastCGI, router web, generación del plan privilegiado, dispatcher y CLI.
