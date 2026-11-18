# Referencia de CLI

La CLI detecta automáticamente el daemon: si `run/api.sock` responde y `run/api.token` es legible, usa la API; en caso contrario usa el mismo `engine` en proceso. Todos los comandos funcionan offline salvo los que necesitan descargas.

| Comando | Descripción |
|---|---|
| `lair install` | Bootstrap local (Composer verificado, shims, perfiles, CA) y generación de los scripts privilegiados. |
| `lair uninstall [--delete-data]` | Revierte perfiles/shims y genera el script de reversión. Los datos se conservan salvo `--delete-data`. |
| `lair status [--json]` | Estado de PHP, Node, servicios, sitios, jobs y defaults. |
| `lair doctor` | Comprueba si `<LAIR_HOME>/bin` está en PATH, qué shims faltan y qué versiones hay instaladas. Imprime el `export PATH=...` necesario. |
| `lair restart` | Reinicia todos los servicios supervisados activos. |
| `lair update` | Fuerza el refresco del catálogo firmado. |
| `lair php install [version]` | Instala una línea minor (p. ej. `8.4`) o una versión exacta. |
| `lair php list` | Versiones instaladas; `*` marca la default. |
| `lair php use <minor>` | Cambia la default. |
| `lair node install [version]` / `list` / `default <version>` | Equivalente para Node. |
| `lair services [list]` | Lista servicios, versión activa, puerto y estado. |
| `lair services install <id> [ver] [--port N]` | Descarga e inicializa una versión. No cambia la activa si ya hay una. |
| `lair services use <id> <version>` | Cambia la versión activa (los datos se conservan). |
| `lair services update <id> [ver]` | Instala, activa y reinicia. |
| `lair services uninstall <id> [ver] [--delete-data]` | Elimina la instalación; datos preservados por defecto. |
| `lair services create-db <id> <name>` | Ejecuta el comando de creación de BD del servicio. |
| `lair services restart\|stop <id>` | Controla el supervisor de un servicio. |
| `lair park` | Registra el directorio actual como `<nombre>.test`. |
| `lair link <name> [path]` | Registra un sitio con host explícito. |
| `lair unlink <name>` | Quita un sitio del router sin tocar los archivos. |
| `lair secure [name]` | Emite certificado local para el sitio (y su wildcard). |
| `lair pin php\|node <version>` | Escribe `.lairrc` en el proyecto (versionable). Los proyectos con `.flockrc` siguen funcionando y se migran al pinar. |
| `lair isolate php\|node <version\|--off>` | Fija una versión para un sitio aparcado (config.json, prioridad máxima). |
| `lair logs [name]` | Muestra un log o lista los disponibles. |
| `lair daemon --foreground` | Ejecuta el daemon en primer plano. Flags: `--no-web`, `--no-dns`, `--no-api`, `--dns-port`, `--http-port`, `--https-port`, `--domain`. |

## Comando oculto `exec`

Los shims de `bin/` contienen:

```sh
exec "<lair>" exec <tool> "$@"
```

`lair exec` resuelve la versión según `isolated > .lairrc (legacy .flockrc) > (.nvmrc/.node-version) > default > newest`, construye el entorno y usa `execve` para reemplazar el proceso. Si falta la versión y stdin es un TTY, ofrece instalarla; si no hay TTY (p. ej. desde un script), falla con un mensaje claro.

Variables de entorno relevantes:

- `LAIR_HOME`: override del directorio de datos.
- `XDG_DATA_HOME`: base alternativa (`$XDG_DATA_HOME/lair`).
- `LAIR_MANIFEST_BASE_URLS`: lista de mirrors separada por comas.
- `LAIR_COMPOSER_DOWNLOAD_URL` / `LAIR_COMPOSER_CHECKSUM_URL`: URLs alternativas para `composer.phar` y su checksum (el SHA-256 se sigue verificando).

## Shims y PATH

`lair install` genera los shims en `<LAIR_HOME>/bin` y añade ese directorio al PATH antes de cualquier descarga. Cualquier comando `lair ... install` vuelve a generarlos al terminar. Si `node -v` no se reconoce, ejecuta `lair doctor`: indicará si faltan shims o si el directorio no está en PATH, y mostrará cómo corregirlo sin reiniciar la terminal.
