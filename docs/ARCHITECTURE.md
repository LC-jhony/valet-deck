# Arquitectura

## Estructura de paquetes

```
cmd/lair                  único binario: CLI, daemon y hidden `exec`
internal/
  app/                    identidad, rutas (LAIR_HOME/XDG), plataforma del manifiesto
  assets/                 clave pública Ed25519 y logos embebidos (go:embed)
  manifest/               catálogo firmado, verificación, control de serial y caché
  download/               descarga con hash en streaming, .part, extracción segura
  installer/              jobs (fases, progreso, cancelación, logs), hooks OnSuccess
  config/                 store atómico de config.json (0600)
  php/                    versiones en paralelo, php.ini, marcadores, FPM/Xdebug
  composer/               phar verificado contra getcomposer.org
  node/                   builds oficiales, resolución por proyecto, prefijos npm
  shims/                  wrappers en bin/ y snippets de perfil de shell
  services/               Specs puros, init de datos, create-db, detección de puertos
  supervisor/             loop de supervisión, backoff, grupos de procesos, logs
  platform/               unit systemd, polkit, resolved, trust store, plan privilegiado
  dns/                    DNS UDP mínimo: *.test -> loopback, resto se reenvía
  pki/                    CA local y certificados por sitio
  fastcgi/                cliente FastCGI mínimo (RESPONDER) hacia PHP-FPM
  web/                    router por Host, archivos estáticos, proxy FastCGI, TLS dinámico
  daemon/                 API unix+token, protocolo de acciones, dispatcher y runtime
  engine/                 orquestación compartida por daemon y CLI
  cli/                    comandos, conexión daemon/offline, resolución de shims
  version/                parser semver y resolución exacta/major
```

## Interfaces clave

| Paquete | Tipo | Responsabilidad |
|---|---|---|
| `manifest` | `Catalog` | `Refresh`, `LoadFromCache`, `Start`, `Subscribe` (hook `OnChange`) |
| `installer` | `Manager`, `Job`, `Request` | `Start(ctx, Request)`, `Status`, `Cancel`, `OnSuccess` |
| `config` | `Store` | `Update(fn)`, `View()` con escritura atómica |
| `services` | `Spec` | Contrato puro del proceso: `Executable`, `Args`, `Env`, `DataDir`, `ClientTools` |
| `supervisor` | `Runner`, `Process`, `Supervisor` | `Start`, `Wait`, `Signal`, `Run`, `Update`, `State` |
| `platform` | `PrivilegedPlan` | `BuildPlan(cfg)`, `Script()`, `InstallTrust(ca)` |
| `dns` | `Server` | `Resolve`, `LocalName`, `ListenAndServe` |
| `web` | `Server`, `Router` | `Match(host)`, `ServeHTTP`, `Start`, `Shutdown` |
| `daemon` | `Server`, `Client`, `Caller`, `Dispatcher` | `Handle`, `Serve`, `Call` |
| `engine` | `Engine` | `InstallPHP`, `InstallNode`, `InstallService`, `Status`, `ResolveTool`, `Bootstrap` |

## Flujo de una instalación

```
CLI/daemon -> Engine.InstallX
   -> manifest.Get + VerifyArtifact (sha256, no yanked)
   -> installer.Manager.Start
        -> Downloader.DownloadToProgress (.part + sha256 en streaming)
        -> download.Extract (safeJoin) -> staging -> os.Rename
        -> archivo `build` -> config.json -> OnSuccess (php.ini, init de datos)
   -> Job.Status (downloading -> installing -> done)
```

## Flujo de una petición HTTP

```
*.test -> systemd-resolved -> DNS 127.0.0.1:53535 -> 127.0.0.1
   -> web.Server (80/443, TLS con certificado emitido por la CA local)
   -> Router.Match(Host)
   -> archivo estático en public/  OR  FastCGI -> socket FPM del sitio
```

## Comunicación CLI ↔ daemon

`internal/daemon/protocol.go` define los nombres de acción y los payloads. El daemon registra un `Dispatcher` en el `Server` de la API; la CLI crea un `Client` si `run/api.sock` responde y, si no, usa el mismo `Dispatcher` contra un `Engine` local. Así no hay dos implementaciones de la lógica de negocio.

El token se genera con `crypto/rand`, se escribe en `run/api.token` con `0600` y se compara con `subtle.ConstantTimeCompare`.

## Decisiones de implementación

- **Sin dependencias externas.** El módulo solo usa la biblioteca estándar; eso permite un binario único y reproducible sin deployment de dependencias en la máquina del usuario.
- **Capa web embebida.** En lugar de distribuir un proxy externo, se implementa la capa necesaria en Go (`net/http` + `GetCertificate` + FastCGI). Cubre router por host, estáticos y proxy a FPM.
- **Privilegios únicos y previos.** Ninguna acción privilegiada se ejecuta en caliente: se genera un script que el usuario revisa y ejecuta una vez. El drop-in de systemd usa `AmbientCapabilities=CAP_NET_BIND_SERVICE`, sin ejecutar el daemon como root.
- **Un solo writer de config.** En producción el daemon posee el `Store`; la CLI solo lo usa en modo offline/bootstrap.
